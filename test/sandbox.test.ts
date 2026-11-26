import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { mergeSandboxEnv } from '../src/commands/sandbox.js';

describe('sandbox environment setup', () => {
  it('adds or replaces only GP credential and environment entries', () => {
    const contents = 'OTHER=value\r\nGP_API_APP_ID=old\r\n# keep me\r\n';
    const result = mergeSandboxEnv(contents, {
      GP_API_APP_ID: 'new-id',
      GP_API_APP_KEY: 'key=value#with-specials',
      GP_API_ENVIRONMENT: 'sandbox'
    });

    expect(result).toBe(
      'OTHER=value\r\nGP_API_APP_ID="new-id"\r\n# keep me\r\nGP_API_APP_KEY="key=value#with-specials"\r\nGP_API_ENVIRONMENT="sandbox"\r\n'
    );
  });

  it.each(['plainKey123', 'ab"cd', 'x\\y', "it's\\", 'k=v#h', 'a\'b"c'])(
    'writes %s so the env file reads back the same value',
    (appKey) => {
      const written = mergeSandboxEnv('', { GP_API_APP_ID: 'id', GP_API_APP_KEY: appKey, GP_API_ENVIRONMENT: 'sandbox' });
      expect(parseEnv(written).GP_API_APP_KEY).toBe(appKey);
    }
  );

  it('does not allow credential values to inject additional env entries', () => {
    expect(() =>
      mergeSandboxEnv('', {
        GP_API_APP_ID: 'app-id',
        GP_API_APP_KEY: 'secret\nGP_API_ENVIRONMENT=production',
        GP_API_ENVIRONMENT: 'sandbox'
      })
    ).toThrow(/line breaks/);
  });

  it('finishes interactive credential entry without echoing the app key', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gp-sandbox-prompt-'));
    try {
      const preloader = path.join(root, 'tty.cjs');
      await writeFile(preloader, `
        Object.defineProperty(process.stdin, 'isTTY', { value: true });
        process.stdin.setRawMode = function (value) { this.isRaw = value; return this; };
      `);
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('GP_API_')) delete env[key];
      }
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const child = spawn(process.execPath, [
        '--require', preloader, '--import', tsx, path.resolve('src', 'bin.ts'), 'sandbox', 'create'
      ], { cwd: root, env });
      let output = '';
      let sentId = false;
      let sentKey = false;
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (!sentId && output.includes('GP API app ID:')) {
          sentId = true;
          child.stdin.write('test-app-id\n');
        }
        if (!sentKey && output.includes('GP API app key (input hidden):')) {
          sentKey = true;
          child.stdin.write('test-secret-key\n');
        }
      });
      const exit = await new Promise<number | null>((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, 10_000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (timedOut) reject(new Error(`Interactive sandbox setup did not exit; output: ${output}`));
          else resolve(code);
        });
      });
      expect(exit).toBe(0);
      expect(sentKey).toBe(true);
      expect(output).not.toContain('test-secret-key');
      expect(await readFile(path.join(root, '.env'), 'utf8')).toContain('GP_API_APP_KEY="test-secret-key"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('refuses a pasted credential with a space in it instead of saving it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gp-sandbox-space-'));
    try {
      const preloader = path.join(root, 'tty.cjs');
      await writeFile(preloader, `
        Object.defineProperty(process.stdin, 'isTTY', { value: true });
        process.stdin.setRawMode = function (value) { this.isRaw = value; return this; };
      `);
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('GP_API_')) delete env[key];
      }
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const child = spawn(process.execPath, [
        '--require', preloader, '--import', tsx, path.resolve('src', 'bin.ts'), 'sandbox', 'create'
      ], { cwd: root, env });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('GP API app ID:')) child.stdin.write('test-app-id # gitleaks:allow\n');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      const exit = await new Promise<number | null>((resolve) => child.once('close', resolve));
      expect(exit).toBe(2);
      expect(output).toContain('GP_API_APP_ID contains a space');
      await expect(readFile(path.join(root, '.env'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not save production credentials from the environment as sandbox credentials', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gp-sandbox-prod-'));
    try {
      const env = { ...process.env, GP_API_APP_ID: 'prod-id', GP_API_APP_KEY: 'prod-key', GP_API_ENVIRONMENT: 'production' };
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        process.execPath,
        ['--import', tsx, path.resolve('src', 'bin.ts'), 'sandbox', 'create', '--json'],
        { cwd: root, env, encoding: 'utf8' }
      );

      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stdout).error.message).toMatch(/GP_API_ENVIRONMENT=production/);
      expect(existsSync(path.join(root, '.env'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('reports an env file it cannot write as a config error, not a bug', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gp-sandbox-readonly-'));
    try {
      await writeFile(path.join(root, 'locked.env'), '', { mode: 0o400 });
      const env: NodeJS.ProcessEnv = { ...process.env, GP_API_APP_ID: 'id', GP_API_APP_KEY: 'key' };
      delete env.GP_API_ENVIRONMENT;
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const result = spawnSync(
        process.execPath,
        ['--import', tsx, path.resolve('src', 'bin.ts'), 'sandbox', 'create', '--env-file', 'locked.env', '--json'],
        { cwd: root, env, encoding: 'utf8' }
      );

      const envelope = JSON.parse(result.stdout);
      expect(envelope.error.code).toBe('E_CONFIG_READ');
      expect(envelope.error.message).toMatch(/locked\.env \(EACCES\)/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
