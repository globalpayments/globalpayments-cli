import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFile } from '../src/config/env.js';

describe('loadEnvFile', () => {
  const originalAppId = process.env.GP_API_APP_ID;
  const originalAppKey = process.env.GP_API_APP_KEY;

  afterEach(() => {
    if (originalAppId === undefined) {
      delete process.env.GP_API_APP_ID;
    } else {
      process.env.GP_API_APP_ID = originalAppId;
    }

    if (originalAppKey === undefined) {
      delete process.env.GP_API_APP_KEY;
    } else {
      process.env.GP_API_APP_KEY = originalAppKey;
    }
  });

  it('loads values from a provided env file', async () => {
    delete process.env.GP_API_APP_ID;
    delete process.env.GP_API_APP_KEY;

    const root = await mkdtemp(path.join(os.tmpdir(), 'gpcli-env-'));
    const envPath = path.join(root, '.env');
    await writeFile(envPath, 'GP_API_APP_ID=from-file\nGP_API_APP_KEY=from-file-key\n', 'utf8');

    loadEnvFile(envPath);

    expect(process.env.GP_API_APP_ID).toBe('from-file');
    expect(process.env.GP_API_APP_KEY).toBe('from-file-key');
  });

  it('does not override values already set in process.env', async () => {
    process.env.GP_API_APP_ID = 'from-shell';
    delete process.env.GP_API_APP_KEY;

    const root = await mkdtemp(path.join(os.tmpdir(), 'gpcli-env-priority-'));
    const envPath = path.join(root, '.env');
    await writeFile(envPath, 'GP_API_APP_ID=from-file\nGP_API_APP_KEY=from-file-key\n', 'utf8');

    loadEnvFile(envPath);

    expect(process.env.GP_API_APP_ID).toBe('from-shell');
    expect(process.env.GP_API_APP_KEY).toBe('from-file-key');
  });

  it('ignores missing default .env file', () => {
    expect(() => loadEnvFile('.env')).not.toThrow();
  });

  it('throws for a missing custom env file path', () => {
    expect(() => loadEnvFile('./missing-custom.env')).toThrow('Env file not found');
  });
});
