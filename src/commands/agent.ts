import { execFile, spawn } from 'node:child_process';
import { Command } from 'commander';
import pc from 'picocolors';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureGitignoreEntries } from '../io/gitignore.js';
import { runCommand } from '../contract/emit.js';
import { ERROR_CODES, GlobalPaymentsError } from '../contract/errors.js';
import { loadEnvFile } from '../config/env.js';
import { loadObserverConfig } from '../config/load.js';

const MCP_REPOSITORY = 'https://github.com/globalpayments/mcp-server.git';
const MCP_REVISION = 'f177cbe6d612d63eb4a219940ad133e4583ec428';
const SKILLS_REPOSITORY = 'globalpayments/agent-skills';
const MANAGED_START = '<!-- globalpayments-cli:start -->';
const MANAGED_END = '<!-- globalpayments-cli:end -->';

export type AgentEditor = 'claude-code' | 'cursor' | 'github-copilot';

export interface AgentSetupData {
  editors: AgentEditor[];
  mcpInstallDirectory: string;
  configFiles: string[];
  agentsFile: string;
  gitignoreFile?: string;
  skillsRepository: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function detectAgentEditors(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (filePath: string) => boolean = existsSync
): AgentEditor[] {
  const found: AgentEditor[] = [];
  const terminal = env.TERM_PROGRAM?.toLowerCase();

  if (env.CLAUDECODE || exists(path.join(root, '.claude')) || exists(path.join(root, '.mcp.json'))) {
    found.push('claude-code');
  }
  if (
    env.CURSOR_TRACE_ID ||
    terminal === 'cursor' ||
    exists(path.join(root, '.cursor'))
  ) {
    found.push('cursor');
  }
  if (
    env.VSCODE_PID ||
    terminal === 'vscode' ||
    exists(path.join(root, '.vscode'))
  ) {
    found.push('github-copilot');
  }
  return found;
}

function normalizeEditor(value: string): AgentEditor {
  const normalized = value.toLowerCase();
  if (normalized === 'claude' || normalized === 'claude-code') return 'claude-code';
  if (normalized === 'cursor') return 'cursor';
  if (normalized === 'vscode' || normalized === 'vs-code' || normalized === 'github-copilot') {
    return 'github-copilot';
  }
  throw new GlobalPaymentsError(
    ERROR_CODES.E_USAGE,
    `Unsupported editor: ${value}. Choose claude-code, cursor, or vscode.`
  );
}

function skillAgent(editor: AgentEditor): string {
  return editor;
}

function mcpConfigLocation(root: string, editor: AgentEditor): { path: string; key: 'servers' | 'mcpServers'; launcher: string; cwd: string } {
  if (editor === 'github-copilot') {
    return {
      path: path.join(root, '.vscode', 'mcp.json'),
      key: 'servers',
      launcher: '${workspaceFolder}/.globalpayments/agent/launch-mcp.mjs',
      cwd: '${workspaceFolder}'
    };
  }
  if (editor === 'cursor') {
    return {
      path: path.join(root, '.cursor', 'mcp.json'),
      key: 'mcpServers',
      launcher: '${workspaceFolder}/.globalpayments/agent/launch-mcp.mjs',
      cwd: '${workspaceFolder}'
    };
  }
  return {
    path: path.join(root, '.mcp.json'),
    key: 'mcpServers',
    launcher: '${CLAUDE_PROJECT_DIR:-.}/.globalpayments/agent/launch-mcp.mjs',
    cwd: '${CLAUDE_PROJECT_DIR:-.}'
  };
}

export function mergeMcpConfig(
  contents: string,
  key: 'servers' | 'mcpServers',
  serverConfig: Record<string, unknown>
): string {
  let parsed: unknown = {};
  if (contents.trim()) {
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new GlobalPaymentsError(
          ERROR_CODES.E_CONFIG_INVALID,
          'Existing MCP configuration is not valid JSON; it was left unchanged.',
          { cause: error }
        );
      }
      throw error;
    }
  }
  if (!isRecord(parsed)) {
    throw new GlobalPaymentsError(ERROR_CODES.E_CONFIG_INVALID, 'Existing MCP configuration must be a JSON object.');
  }

  const existing = parsed[key] ?? {};
  if (!isRecord(existing)) {
    throw new GlobalPaymentsError(ERROR_CODES.E_CONFIG_INVALID, `Existing MCP configuration field "${key}" must be an object.`);
  }

  return `${JSON.stringify(
    {
      ...parsed,
      [key]: {
        ...existing,
        'global-payments': serverConfig
      }
    },
    null,
    2
  )}\n`;
}

export function mergeAgentsGuide(contents: string): string {
  const section = `${MANAGED_START}
## Global Payments CLI

- Start with \`globalpayments explain --json\` for the live command contract.
- Configure an existing sandbox app with \`globalpayments sandbox create\`; credentials stay in the local \`.env\` file.
- Use \`globalpayments api get\`, \`globalpayments api post\`, and \`globalpayments transactions get\` for direct API work. API writes are sandbox-only.
- Use \`globalpayments run --cert <packId>\` to evaluate transactions your integration has already sent.
- Use \`globalpayments listen\` and \`globalpayments trigger\` for local synthetic webhook testing; these do not register a real GP webhook.
- Never print, commit, or send app keys, access tokens, card numbers, or security codes.
${MANAGED_END}`;
  const start = contents.indexOf(MANAGED_START);
  const end = contents.indexOf(MANAGED_END);

  if (start === -1 && end === -1) {
    return `${contents.trimEnd()}${contents.trim() ? '\n\n' : ''}${section}\n`;
  }
  if (
    start === -1 ||
    end === -1 ||
    end < start ||
    contents.indexOf(MANAGED_START, start + 1) !== -1 ||
    contents.indexOf(MANAGED_END, end + 1) !== -1
  ) {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_CONFIG_INVALID,
      'AGENTS.md has an incomplete or duplicated Global Payments CLI section; it was left unchanged.'
    );
  }
  return `${contents.slice(0, start)}${section}${contents.slice(end + MANAGED_END.length)}`;
}

export function createLauncherScript(): string {
  return `import { existsSync } from 'node:fs';
import path from 'node:path';

const projectRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const envFile = path.join(projectRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const appId = process.env.GP_API_APP_ID;
const appKey = process.env.GP_API_APP_KEY;
if (!appId || !appKey) throw new Error('GP_API_APP_ID and GP_API_APP_KEY must be configured in .env or the process environment.');
if ((process.env.GP_API_ENVIRONMENT ?? 'sandbox').toLowerCase() !== 'sandbox') {
  throw new Error('The Global Payments MCP server is restricted to sandbox credentials.');
}

process.env.GPAPI_APP = \`\${appId}:\${appKey}\`;
process.env.ENV = 'SANDBOX';
if (process.env.GP_API_ACCOUNT_NAME) process.env.GPAPI_ACCOUNT_NAME = process.env.GP_API_ACCOUNT_NAME;
if (process.env.GP_API_VERSION) process.env.API_VERSION = process.env.GP_API_VERSION;
await import(new URL('./server/lib/index.js', import.meta.url).href);
`;
}

function isNodeVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 20);
}

function runInstaller(command: 'git' | 'npm' | 'npx' | 'node', args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'ignore',
      shell: process.platform === 'win32'
    });
    child.once('error', (error) => {
      reject(
        new GlobalPaymentsError(
          ERROR_CODES.E_AGENT_SETUP_FAILED,
          `Unable to start ${command} for agent setup.`,
          { details: { command, cause: error.message } }
        )
      );
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new GlobalPaymentsError(
          ERROR_CODES.E_AGENT_SETUP_FAILED,
          `${command} failed during agent setup.`,
          { details: { command, exitCode: code, signal } }
        )
      );
    });
  });
}

function gitOutput(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(new GlobalPaymentsError(
          ERROR_CODES.E_AGENT_SETUP_FAILED,
          'Unable to verify the existing MCP server checkout.',
          { cause: error, remediation: 'Inspect the local MCP server checkout before retrying setup.' }
        ));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function installMcpServer(root: string, installDirectory: string): Promise<void> {
  const serverDirectory = path.join(installDirectory, 'server');
  const marker = path.join(installDirectory, 'managed-mcp-revision');
  if (
    (existsSync(installDirectory) && lstatSync(installDirectory).isSymbolicLink()) ||
    (existsSync(marker) && (
      lstatSync(marker).isSymbolicLink() ||
      (await readFile(marker, 'utf8')).trim() !== MCP_REVISION
    ))
  ) {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_AGENT_SETUP_FAILED,
      'The existing MCP installation is not managed by this setup; it was left unchanged.',
      { remediation: 'Inspect the local MCP installation before retrying setup.' }
    );
  }
  if (!existsSync(serverDirectory)) {
    await mkdir(installDirectory, { recursive: true });
    if (!existsSync(marker)) await writeFile(marker, `${MCP_REVISION}\n`, 'utf8');
    await runInstaller('git', ['clone', '--no-checkout', MCP_REPOSITORY, path.join('.globalpayments', 'agent', 'server')], root);
    await runInstaller('git', ['checkout', '--detach', MCP_REVISION], serverDirectory);
  } else if (
    lstatSync(serverDirectory).isSymbolicLink() ||
    !existsSync(marker) ||
    (await readFile(marker, 'utf8')).trim() !== MCP_REVISION
  ) {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_AGENT_SETUP_FAILED,
      'The existing MCP server directory is not a managed checkout; it was left unchanged.',
      { remediation: 'Inspect the local MCP server directory before retrying setup.' }
    );
  }

  const revision = await gitOutput(['rev-parse', 'HEAD'], serverDirectory);
  const changes = await gitOutput(['status', '--porcelain', '--untracked-files=no'], serverDirectory);
  if (revision !== MCP_REVISION || changes) {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_AGENT_SETUP_FAILED,
      'The existing MCP server checkout has a different revision or local changes; it was left unchanged.',
      { remediation: 'Inspect the local MCP server checkout before retrying setup.' }
    );
  }

  if (!existsSync(path.join(serverDirectory, 'lib', 'index.js')) || !existsSync(path.join(serverDirectory, 'node_modules', 'typescript'))) {
    await runInstaller('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], serverDirectory);
    await runInstaller('node', [path.join('node_modules', 'typescript', 'bin', 'tsc')], serverDirectory);
  }
}

async function writeMcpConfig(
  root: string,
  editor: AgentEditor,
  launcherConfig: Record<string, unknown>
): Promise<string> {
  const location = mcpConfigLocation(root, editor);
  const contents = existsSync(location.path) ? await readFile(location.path, 'utf8') : '';
  await mkdir(path.dirname(location.path), { recursive: true });
  await writeFile(location.path, mergeMcpConfig(contents, location.key, launcherConfig), 'utf8');
  return location.path;
}

function collectEditor(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command('agent').description('Set up Global Payments tooling for AI coding agents');

  agent
    .command('setup')
    .description('Install the GP MCP server and SDK skills for detected Claude Code, Cursor, or VS Code projects')
    .option('--editor <name>', 'Target editor (repeatable): claude-code, cursor, or vscode', collectEditor, [])
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { editor: string[]; json?: boolean }) => {
      await runCommand<AgentSetupData>('agent.setup', { json: options.json }, async (reportProgress) => {
        if (!isNodeVersionSupported(process.versions.node)) {
          throw new GlobalPaymentsError(
            ERROR_CODES.E_AGENT_SETUP_FAILED,
            'The skills installer requires Node.js 22.20 or newer.',
            { details: { nodeVersion: process.versions.node } }
          );
        }

        loadEnvFile('.env');
        const config = await loadObserverConfig();
        if (config.environment !== 'sandbox') {
          throw new GlobalPaymentsError(
            ERROR_CODES.E_CONFIG_INVALID,
            'Agent setup is sandbox-only.',
            { details: { environment: config.environment } }
          );
        }
        if (!process.env.GP_API_APP_ID || !process.env.GP_API_APP_KEY) {
          throw new GlobalPaymentsError(
            ERROR_CODES.E_AUTH_MISSING_CREDENTIALS,
            'Set up sandbox credentials before installing the GP MCP server.'
          );
        }

        const root = process.cwd();
        const editors = options.editor.length > 0
          ? [...new Set(options.editor.map(normalizeEditor))]
          : detectAgentEditors(root);
        if (editors.length === 0) {
          throw new GlobalPaymentsError(
            ERROR_CODES.E_USAGE,
            'No supported coding agent was detected.',
            { remediation: 'Run `globalpayments agent setup --editor claude-code`, `--editor cursor`, or `--editor vscode`.' }
          );
        }

        const installDirectory = path.join(root, '.globalpayments', 'agent');
        const launcherConfig = (editor: AgentEditor): Record<string, unknown> => {
          const location = mcpConfigLocation(root, editor);
          return {
            type: 'stdio',
            command: 'node',
            args: [location.launcher],
            cwd: location.cwd
          };
        };
        for (const editor of editors) {
          const location = mcpConfigLocation(root, editor);
          const existing = existsSync(location.path) ? await readFile(location.path, 'utf8') : '';
          mergeMcpConfig(existing, location.key, launcherConfig(editor));
        }

        const agentsPath = path.join(root, 'AGENTS.md');
        const existingAgents = existsSync(agentsPath) ? await readFile(agentsPath, 'utf8') : '';
        const agentsContents = mergeAgentsGuide(existingAgents);
        const gitignoreFile = await ensureGitignoreEntries(root, ['/.globalpayments/agent/']);

        reportProgress('Installing the Global Payments MCP server for sandbox use.');
        await installMcpServer(root, installDirectory);

        await writeFile(path.join(installDirectory, 'launch-mcp.mjs'), createLauncherScript(), 'utf8');

        reportProgress(`Installing SDK skills for ${editors.join(', ')}.`);
        const skillArgs = [
          '--yes',
          'skills',
          'add',
          SKILLS_REPOSITORY,
          '--skill',
          '*',
          '--copy'
        ];
        for (const editor of editors) {
          skillArgs.push('--agent', skillAgent(editor));
        }
        skillArgs.push('--yes');
        await runInstaller('npx', skillArgs, root);

        const configFiles: string[] = [];
        for (const editor of editors) {
          configFiles.push(await writeMcpConfig(root, editor, launcherConfig(editor)));
        }

        await writeFile(agentsPath, agentsContents, 'utf8');

        const data: AgentSetupData = {
          editors,
          mcpInstallDirectory: installDirectory,
          configFiles,
          agentsFile: agentsPath,
          ...(gitignoreFile ? { gitignoreFile } : {}),
          skillsRepository: SKILLS_REPOSITORY
        };
        return {
          data,
          render: (result) => {
            console.log(pc.green('✓'), `Installed MCP server and SDK skills for ${result.editors.join(', ')}.`);
            console.log(pc.gray(`  MCP settings: ${result.configFiles.join(', ')}`));
            console.log(pc.gray(`  Agent guidance: ${result.agentsFile}`));
            if (result.gitignoreFile) console.log(pc.gray(`  Ignored local MCP install in ${result.gitignoreFile}`));
          },
          nextActions: [
            { reason: 'Restart or refresh the coding agent to load its new MCP tools and skills.', command: 'globalpayments explain --json' }
          ]
        };
      });
    });
}
