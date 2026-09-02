import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { CertificationEngine } from '../src/core/engine.js';
import { StubGpApiClient } from '../src/gpapi/client.js';
import { resolveInheritedPack } from '../src/core/pack-resolver.js';
import { caseAddress } from '../src/core/ids.js';
import {
  certificationError,
  collectRunResult,
  createSession,
  isRequiredCase,
  resolveSelection,
  type CertificationSession
} from '../src/core/session.js';
import { ERROR_CODES } from '../src/contract/errors.js';
import { RESULT_SCHEMA_VERSION } from '../src/contract/version.js';
import type { CertificationPack, ObserverConfig, ResolvedObserverConfig } from '../src/types/domain.js';

const config = {
  version: 1,
  environment: 'sandbox',
  auth: { mode: 'app-credentials', appId: 'a', appKey: 'b', apiVersion: '2021-03-22' },
  account: {},
  polling: { intervalMs: 1000, lookbackMinutes: 10, overlapSeconds: 30, pageSize: 100, order: 'DESC' },
  matching: { defaultStrategy: 'composite', requireReference: false, timeSkewSeconds: 60 },
  output: { format: 'terminal', saveJson: true, saveJUnit: false },
  packs: {},
  configPath: '.gpcli/config.yaml'
} as unknown as ResolvedObserverConfig;

function buildPack(cases: Array<{ id: string; required: boolean }>): CertificationPack {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    casesDirectory: 'cases',
    cases: cases.map((c) => ({
      id: c.id,
      name: c.id,
      required: c.required,
      matcher: { type: 'SALE' },
      expect: { latest: { statusIn: ['CAPTURED'] } }
    }))
  };
}

function buildSession(cases: Array<{ id: string; required: boolean }>): CertificationSession {
  const graph = new Map([['demo', buildPack(cases)]]);
  const pack = resolveInheritedPack('demo', graph);

  const caseIndex = new Map(pack.cases.map((c) => [caseAddress(pack.id, c.id), c]));
  const engine = new CertificationEngine(
    config as unknown as ObserverConfig,
    [pack],
    new StubGpApiClient({} as never),
    {},
    {}
  );

  return {
    config,
    activePacks: ['demo'],
    packs: [pack],
    caseIndex,
    engine,
    authInput: { appId: 'a', appKey: 'b', environment: 'sandbox', apiVersion: '2021-03-22' },
    authProvider: {} as never
  };
}

describe('session: result collection', () => {
  it('stamps the artifact with a schema version so consumers can validate it', async () => {
    const session = buildSession([{ id: 'a', required: true }]);
    const result = await collectRunResult(session, { skipDiagnostics: true });
    expect(result.schemaVersion).toBe(RESULT_SCHEMA_VERSION);
    expect(result.environment).toBe('sandbox');
  });

  it('derives the verdict solely from required cases', async () => {
    const session = buildSession([
      { id: 'required-one', required: true },
      { id: 'optional-one', required: false }
    ]);

    // No transactions are ever returned by the stub, so everything stays pending.
    await session.engine.runOnce();
    const result = await collectRunResult(session, { skipDiagnostics: true });

    expect(result.verdict).toBe('failed');
    expect(result.required).toEqual({ total: 1, passing: 0, failing: 1 });
    expect(result.summary.total).toBe(2);
  });

  it('reports addresses that match the catalog exactly', async () => {
    const session = buildSession([{ id: 'a', required: true }]);
    const result = await collectRunResult(session, { skipDiagnostics: true });
    expect(result.cases.map((c) => c.namespacedCaseId)).toEqual(['demo:a']);
    expect([...session.caseIndex.keys()]).toEqual(['demo:a']);
  });

  it('knows which addresses are required', () => {
    const session = buildSession([
      { id: 'a', required: true },
      { id: 'b', required: false }
    ]);
    expect(isRequiredCase(session, 'demo:a')).toBe(true);
    expect(isRequiredCase(session, 'demo:b')).toBe(false);
    expect(isRequiredCase(session, 'demo:missing')).toBe(false);
  });

  it('redacts credentials from the persisted config snapshot', async () => {
    const session = buildSession([{ id: 'a', required: true }]);
    const result = await collectRunResult(session, { skipDiagnostics: true });
    const auth = result.redactedConfig.auth as Record<string, unknown>;
    expect(auth.appKey).toBe('[REDACTED]');
  });
});

describe('session: certification verdict to error', () => {
  it('produces no error when the verdict passed', async () => {
    const session = buildSession([{ id: 'a', required: false }]);
    const result = await collectRunResult(session, { skipDiagnostics: true });
    expect(result.verdict).toBe('passed');
    expect(certificationError(result)).toBeUndefined();
  });

  it('produces a CERT_FAILED error listing the offending addresses', async () => {
    const session = buildSession([{ id: 'a', required: true }]);
    const result = await collectRunResult(session, { skipDiagnostics: true });

    const error = certificationError(result);
    expect(error?.code).toBe('E_CERT_REQUIRED_CASES_FAILING');
    expect(error?.exitCode).toBe(1);
    expect(error?.details?.notPassing).toEqual(['demo:a']);
  });
});

describe('session: discovery works without credentials', () => {
  const original = { id: process.env['GP_API_APP_ID'], key: process.env['GP_API_APP_KEY'] };
  // An empty env file, so a real .env in the working tree cannot leak credentials
  // into these assertions.
  const emptyEnvFile = path.join(os.tmpdir(), 'gpcli-empty.env');

  beforeEach(() => {
    writeFileSync(emptyEnvFile, '');
    delete process.env['GP_API_APP_ID'];
    delete process.env['GP_API_APP_KEY'];
  });

  afterEach(() => {
    if (original.id === undefined) delete process.env['GP_API_APP_ID'];
    else process.env['GP_API_APP_ID'] = original.id;
    if (original.key === undefined) delete process.env['GP_API_APP_KEY'];
    else process.env['GP_API_APP_KEY'] = original.key;
  });

  // Orientation must never require credentials. An agent has to be able to ask
  // "what suites exist and what do they assert?" before it has secrets wired up.
  it('resolves packs and cases with no credentials present', async () => {
    const selection = await resolveSelection({ cert: 'global-core', envFile: emptyEnvFile });

    expect(selection.activePacks).toEqual(['global-core']);
    expect(selection.caseIndex.size).toBeGreaterThan(0);
    for (const address of selection.caseIndex.keys()) {
      expect(address).toMatch(/^[^:]+:[^:]+$/);
    }
  });

  // ...but the moment authentication is actually needed, it must fail with the
  // auth code, not a config code, so the caller knows what to fix.
  it('createSession fails with E_AUTH_MISSING_CREDENTIALS, not a config error', async () => {
    await expect(createSession({ cert: 'global-core', envFile: emptyEnvFile })).rejects.toMatchObject({
      code: ERROR_CODES.E_AUTH_MISSING_CREDENTIALS
    });
  });
});
