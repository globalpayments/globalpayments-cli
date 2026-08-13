import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigLoadError,
  loadCaseFile,
  loadObserverConfig,
  loadPackManifest,
  resolveConfigPath,
  resolvePackCasesDir,
  resolvePackPath
} from '../src/config/load.js';

describe('config loader', () => {
  it('loads config with environment interpolation and absolute packs path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpcli-config-'));
    const configDir = path.join(root, '.gpcli');
    await mkdir(configDir, { recursive: true });

    const configPath = path.join(configDir, 'config.yaml');
    await writeFile(
      configPath,
      [
        'version: 1',
        'environment: sandbox',
        'auth:',
        '  mode: app-credentials',
        '  appId: ${APP_ID}',
        '  appKey: ${APP_KEY}',
        '  apiVersion: 2021-03-22',
        'account:',
        '  accountName: account-one',
        'polling:',
        '  intervalMs: 5000',
        '  lookbackMinutes: 15',
        '  overlapSeconds: 5',
        '  pageSize: 100',
        '  order: DESC',
        'matching:',
        '  defaultStrategy: reference',
        '  requireReference: true',
        '  timeSkewSeconds: 30',
        'output:',
        '  format: table',
        '  saveJson: true',
        '  saveJUnit: false',
        'packs:',
        '  directory: ../packs',
        'activePacks:',
        '  - global-core'
      ].join('\n'),
      'utf8'
    );

    const config = await loadObserverConfig(configPath, {
      APP_ID: 'my-app-id',
      APP_KEY: 'my-app-key'
    });

    expect(config.auth.appId).toBe('my-app-id');
    expect(config.auth.appKey).toBe('my-app-key');
    expect(config.packs.directory).toBe(path.resolve(configDir, '../packs'));
    expect(config.configPath).toBe(configPath);
  });

  it('resolves default config path and pack paths', () => {
    expect(resolveConfigPath()).toBe('.gpcli/config.yaml');
    expect(resolvePackPath('/tmp/packs', 'global-core')).toBe(path.join('/tmp/packs', 'global-core', 'pack.yaml'));
    expect(resolvePackCasesDir('/tmp/packs', 'global-core', 'cases')).toBe(path.join('/tmp/packs', 'global-core', 'cases'));
  });

  it('loads pack and case yaml files with the new schema shape', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpcli-pack-'));
    const packDir = path.join(root, 'packs', 'global-core');
    const casesDir = path.join(packDir, 'cases');
    await mkdir(casesDir, { recursive: true });

    const packPath = path.join(packDir, 'pack.yaml');
    const casePath = path.join(casesDir, 'sale.yaml');

    await writeFile(
      packPath,
      [
        'id: global-core',
        'name: Global Core',
        'version: 1.0.0',
        'cases:',
        '  directory: cases'
      ].join('\n'),
      'utf8'
    );

    await writeFile(
      casePath,
      [
        'id: sale-approved',
        'name: Sale approved',
        'required: true',
        'matcher:',
        '  reference: cert-sale-1',
        'expect:',
        '  latest:',
        '    statusIn:',
        '      - CAPTURED'
      ].join('\n'),
      'utf8'
    );

    const manifest = await loadPackManifest(packPath);
    const caze = await loadCaseFile(casePath);

    expect(manifest.name).toBe('Global Core');
    expect(manifest.casesDirectory).toBe('cases');
    expect(caze.name).toBe('Sale approved');
    expect(caze.expect.latest?.statusIn).toEqual(['CAPTURED']);
  });

  it('throws ConfigLoadError for malformed YAML', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpcli-bad-yaml-'));
    const configPath = path.join(root, 'config.yaml');
    await writeFile(configPath, 'version: 1\nenvironment: sandbox\nauth: [', 'utf8');

    let caught: unknown;
    try {
      await loadObserverConfig(configPath);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigLoadError);
    const configError = caught as ConfigLoadError;
    expect(configError.code).toBe('yaml-parse');
    expect(configError.message).toContain('Malformed YAML');
  });

  it('throws ConfigLoadError for schema validation issues', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gpcli-bad-schema-'));
    const configPath = path.join(root, 'config.yaml');
    await writeFile(configPath, ['version: 1', 'environment: sandbox', 'auth: {}'].join('\n'), 'utf8');

    let caught: unknown;
    try {
      await loadObserverConfig(configPath);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigLoadError);
    const configError = caught as ConfigLoadError;
    expect(configError.code).toBe('schema-invalid');
    expect(configError.message).toContain('Invalid configuration');
  });
});
