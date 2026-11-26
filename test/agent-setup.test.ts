import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  installerEnvironment,
  detectAgentEditors,
  createLauncherScript,
  mergeAgentsGuide,
  mergeMcpConfig
} from '../src/commands/agent.js';

describe('agent setup helpers', () => {
  it('detects supported editors from project markers and runtime environment', () => {
    const detected = detectAgentEditors(
      'C:\\repo',
      { TERM_PROGRAM: 'vscode', CLAUDECODE: '1' },
      (filePath) => filePath.endsWith('.cursor')
    );
    expect(detected).toEqual(['claude-code', 'cursor', 'github-copilot']);
  });

  describe('agent setup credential loading', () => {
    it('loads sandbox credentials from .env while respecting the process environment', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'globalpayments-agent-'));
      try {
        await writeFile(
          path.join(root, '.env'),
          'GP_API_APP_ID=test-app\nGP_API_APP_KEY=test-key\nGP_API_ENVIRONMENT=sandbox\n'
        );
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
          if (key.startsWith('GP_API_')) delete env[key];
        }
        const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
        const bin = path.resolve('src', 'bin.ts');
        const run = (extraEnv: NodeJS.ProcessEnv = {}) =>
          spawnSync(process.execPath, ['--import', tsx, bin, 'agent', 'setup', '--editor', 'unsupported', '--json'], {
            cwd: root,
            env: { ...env, ...extraEnv },
            encoding: 'utf8'
          });

        const sandbox = run();
        expect(sandbox.status).toBe(2);
        expect(JSON.parse(sandbox.stdout).error.message).toMatch(/Unsupported editor/);

        const production = run({ GP_API_ENVIRONMENT: 'production' });
        expect(production.status).toBe(3);
        expect(JSON.parse(production.stdout).error.message).toMatch(/sandbox-only/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it('merges MCP settings without replacing other servers or top-level options', () => {
    const updated = JSON.parse(
      mergeMcpConfig(
        JSON.stringify({ servers: { other: { command: 'node' } }, inputs: [{ id: 'key' }] }),
        'servers',
        { type: 'stdio', command: 'node', args: ['launcher.mjs'] }
      )
    ) as Record<string, unknown>;

    expect(updated.inputs).toEqual([{ id: 'key' }]);
    expect(updated.servers).toEqual({
      other: { command: 'node' },
      'global-payments': { type: 'stdio', command: 'node', args: ['launcher.mjs'] }
    });
  });

  it('preserves existing agent guidance and updates its managed section idempotently', () => {
    const first = mergeAgentsGuide('# Existing project guidance\n');
    const second = mergeAgentsGuide(first);
    expect(first).toContain('# Existing project guidance');
    expect(first).toContain('API writes are sandbox-only');
    expect(second).toBe(first);
  });

  it('refuses to modify malformed MCP JSON', () => {
    expect(() => mergeMcpConfig('{ invalid', 'mcpServers', {})).toThrow(/valid JSON/);
  });

  it('starts the built server with sandbox credentials from the project env file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'globalpayments-launcher-'));
    try {
      const agent = path.join(root, '.globalpayments', 'agent');
      const server = path.join(agent, 'server', 'lib');
      await mkdir(server, { recursive: true });
      await writeFile(path.join(root, '.env'), 'GP_API_APP_ID=test-app\nGP_API_APP_KEY=test-key\nGP_API_ENVIRONMENT=sandbox\n');
      await writeFile(path.join(agent, 'launch-mcp.mjs'), createLauncherScript());
      await writeFile(
        path.join(server, 'index.js'),
        "if (process.env.GPAPI_APP !== 'test-app:test-key' || process.env.ENV !== 'SANDBOX') process.exit(1); process.stdout.write('started');"
      );
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('GP_API_') || key === 'GPAPI_APP' || key === 'ENV') delete env[key];
      }

      // Editors do not all honour the configured cwd, so start it from somewhere else.
      const result = spawnSync(process.execPath, [path.join(agent, 'launch-mcp.mjs')], {
        cwd: os.tmpdir(),
        env,
        encoding: 'utf8'
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('started');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite an unmanaged server directory during setup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'globalpayments-unmanaged-'));
    try {
      const server = path.join(root, '.globalpayments', 'agent', 'server');
      await mkdir(server, { recursive: true });
      await writeFile(path.join(server, 'keep.txt'), 'user data');
      await writeFile(path.join(root, '.env'), 'GP_API_APP_ID=test-app\nGP_API_APP_KEY=test-key\nGP_API_ENVIRONMENT=sandbox\n');
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('GP_API_')) delete env[key];
      }
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        process.execPath,
        ['--import', tsx, path.resolve('src', 'bin.ts'), 'agent', 'setup', '--editor', 'vscode', '--json'],
        { cwd: root, env, encoding: 'utf8' }
      );
      expect(result.status).toBe(10);
      expect(JSON.parse(result.stdout).error.message).toMatch(/not a managed checkout/);
      expect(await readFile(path.join(server, 'keep.txt'), 'utf8')).toBe('user data');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps GP credentials out of the installer processes', () => {
    const env = installerEnvironment({
      PATH: '/usr/bin',
      GP_API_APP_ID: 'id',
      GP_API_APP_KEY: 'key',
      GPAPI_APP: 'id:key',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/'
    });

    expect(env).toEqual({ PATH: '/usr/bin', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/' });
  });
});
