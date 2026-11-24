import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
});
