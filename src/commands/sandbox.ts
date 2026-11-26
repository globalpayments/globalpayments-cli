import { Command } from 'commander';
import { statusMark, t } from '../ui/index.js';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runCommand } from '../contract/emit.js';
import { ERROR_CODES, GlobalPaymentsError, fileAccessError } from '../contract/errors.js';
import { loadEnvFile } from '../config/env.js';
import { ensureGitignoreEntries } from '../io/gitignore.js';

const CREDENTIAL_KEYS = ['GP_API_APP_ID', 'GP_API_APP_KEY', 'GP_API_ENVIRONMENT'] as const;

export interface SandboxSetupData {
  environment: 'sandbox';
  envFile: string;
  gitignoreFile?: string;
  appIdConfigured: true;
  appKeyConfigured: true;
}

/**
 * Quote a value so Node's .env parser reads back exactly the same string. Inside double
 * quotes that parser does not unescape \" or \\, so a value containing either is written
 * in single quotes (or backticks), which it reads literally.
 */
function serializedEnvValue(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, 'Credential values cannot contain line breaks or null bytes.');
  }
  if (!/["\\]/.test(value)) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('`')) return `\`${value}\``;
  throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, 'Credential values cannot contain all three quote characters.');
}

export function mergeSandboxEnv(contents: string, values: Record<(typeof CREDENTIAL_KEYS)[number], string>): string {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents.length > 0 ? contents.split(/\r?\n/) : [];
  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop();
  }

  for (const key of CREDENTIAL_KEYS) {
    const assignment = `${key}=${serializedEnvValue(values[key])}`;
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const matchingIndexes = lines.flatMap((line, index) => (pattern.test(line) ? [index] : []));

    if (matchingIndexes.length === 0) {
      lines.push(assignment);
      continue;
    }

    for (const index of matchingIndexes) {
      lines[index] = assignment;
    }
  }

  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop();
  }
  return `${lines.join(newline)}${newline}`;
}

async function writeSandboxEnv(
  envFile: string,
  values: Record<(typeof CREDENTIAL_KEYS)[number], string>
): Promise<void> {
  const resolvedPath = path.resolve(envFile);
  const directory = path.dirname(resolvedPath);
  try {
    await mkdir(directory, { recursive: true });

    const existing = existsSync(resolvedPath) ? await readFile(resolvedPath, 'utf8') : '';
    await writeFile(resolvedPath, mergeSandboxEnv(existing, values), {
      encoding: 'utf8',
      mode: 0o600
    });

    if (process.platform !== 'win32') {
      await chmod(resolvedPath, 0o600);
    }
  } catch (error) {
    throw fileAccessError(error, ERROR_CODES.E_CONFIG_READ, 'write', envFile);
  }
}

async function askForAppId(): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question('GP API app ID: ')).trim();
  } finally {
    prompt.close();
  }
}

async function askForHiddenAppKey(): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_USAGE,
      'Interactive credential entry requires a terminal.',
      {
        remediation: 'Set GP_API_APP_ID and GP_API_APP_KEY in the environment, then rerun `globalpayments sandbox create --json`.'
      }
    );
  }

  return new Promise<string>((resolve, reject) => {
    const originalRawMode = input.isRaw;
    let value = '';
    let finished = false;

    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      input.off('data', onData);
      input.setRawMode(originalRawMode);
      input.pause();
      input.unref();
      output.write('\n');
    };

    const onData = (chunk: Buffer | string): void => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          cleanup();
          reject(new GlobalPaymentsError(ERROR_CODES.E_USAGE, 'Credential entry was cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };

    output.write('GP API app key (input hidden): ');
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    input.on('data', onData);
  });
}

async function resolveCredential(
  existingValue: string | undefined,
  name: string,
  prompt: () => Promise<string>,
  replace: boolean,
  json: boolean
): Promise<string> {
  if (existingValue && !replace) {
    return existingValue;
  }
  if (json || !process.stdin.isTTY) {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_USAGE,
      `${name} is missing; JSON mode cannot prompt for credentials.`,
      { remediation: `Set ${name} in the environment and rerun, or use interactive \`globalpayments sandbox create\`.` }
    );
  }

  const value = await prompt();
  if (!value) {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, `${name} cannot be empty.`);
  }
  // A pasted line with a trailing comment or a second value saves fine and then
  // fails every request with a 403, so stop it here.
  if (/\s/.test(value)) {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, `${name} contains a space, and GP app credentials never do.`, {
      remediation: 'Paste only the value from your app in the Developer Portal, without quotes or comments, and run sandbox create again.'
    });
  }
  return value;
}

export function registerSandboxCommands(program: Command): void {
  const sandbox = program.command('sandbox').description('Configure and use GP sandbox credentials');

  sandbox
    .command('create')
    .description('Set up local credentials for an existing GP Developer Portal sandbox app')
    .option('--env-file <path>', 'Env file to create or update', '.env')
    .option('--replace', 'Prompt for credentials even when they are already configured')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { envFile: string; replace?: boolean; json?: boolean }) => {
      await runCommand<SandboxSetupData>('sandbox.create', { json: options.json }, async (reportProgress) => {
        reportProgress('Use an existing sandbox app from https://developer.globalpayments.com; this command does not create an account.');
        if (existsSync(options.envFile)) {
          loadEnvFile(options.envFile);
        }

        // Credentials already in the environment are reused as the sandbox app. If they were
        // configured for another environment they are production keys, and saving them under
        // GP_API_ENVIRONMENT=sandbox would hide that.
        const configuredEnvironment = process.env.GP_API_ENVIRONMENT?.trim().toLowerCase();
        if (
          !options.replace &&
          configuredEnvironment &&
          configuredEnvironment !== 'sandbox' &&
          (process.env.GP_API_APP_ID || process.env.GP_API_APP_KEY)
        ) {
          throw new GlobalPaymentsError(
            ERROR_CODES.E_CONFIG_INVALID,
            `The configured credentials are for GP_API_ENVIRONMENT=${configuredEnvironment}; they were not saved as sandbox credentials.`,
            {
              details: { environment: configuredEnvironment },
              remediation: 'Rerun `globalpayments sandbox create --replace` and enter the sandbox app credentials, or unset the production GP_API_* variables first.'
            }
          );
        }

        const appId = await resolveCredential(
          process.env.GP_API_APP_ID,
          'GP_API_APP_ID',
          askForAppId,
          Boolean(options.replace),
          Boolean(options.json)
        );
        const appKey = await resolveCredential(
          process.env.GP_API_APP_KEY,
          'GP_API_APP_KEY',
          askForHiddenAppKey,
          Boolean(options.replace),
          Boolean(options.json)
        );

        const resolvedEnvFile = path.resolve(options.envFile);
        const relativeEnvFile = path.relative(process.cwd(), resolvedEnvFile);
        const isInsideProject =
          relativeEnvFile !== '' &&
          relativeEnvFile !== '..' &&
          !relativeEnvFile.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativeEnvFile);
        const gitignoreFile = isInsideProject
          ? await ensureGitignoreEntries(process.cwd(), [relativeEnvFile.split(path.sep).join('/')]).catch((error: unknown) => {
              throw fileAccessError(error, ERROR_CODES.E_CONFIG_READ, 'update', '.gitignore');
            })
          : undefined;

        await writeSandboxEnv(options.envFile, {
          GP_API_APP_ID: appId,
          GP_API_APP_KEY: appKey,
          GP_API_ENVIRONMENT: 'sandbox'
        });

        process.env.GP_API_APP_ID = appId;
        process.env.GP_API_APP_KEY = appKey;
        process.env.GP_API_ENVIRONMENT = 'sandbox';

        const data: SandboxSetupData = {
          environment: 'sandbox',
          envFile: resolvedEnvFile,
          appIdConfigured: true,
          appKeyConfigured: true,
          ...(gitignoreFile ? { gitignoreFile } : {})
        };

        return {
          data,
          render: (result) => {
            console.log(statusMark('pass'), `Sandbox credentials saved to ${t.accent(result.envFile)}`);
            if (result.gitignoreFile) console.log(t.muted(`  Added an ignore rule in ${result.gitignoreFile}`));
            console.log(t.muted('  Credentials are not displayed. This command configured an existing app; it did not create an account.'));
          },
          nextActions: [{ reason: 'Verify the credentials and sandbox connectivity.', command: 'globalpayments doctor --json' }]
        };
      });
    });
}
