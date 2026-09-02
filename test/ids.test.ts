import { describe, expect, it } from 'vitest';
import { caseAddress, localCaseId, packIdOf, parseCaseAddress, isCaseAddress } from '../src/core/ids.js';
import { resolveInheritedPack } from '../src/core/pack-resolver.js';
import { CertificationEngine } from '../src/core/engine.js';
import type { CertificationPack, ObserverConfig } from '../src/types/domain.js';
import { StubGpApiClient } from '../src/gpapi/client.js';

function pack(id: string, caseIds: string[], extend?: string[]): CertificationPack {
  return {
    id,
    name: id,
    version: '1.0.0',
    ...(extend ? { extends: extend } : {}),
    casesDirectory: 'cases',
    cases: caseIds.map((caseId) => ({
      id: caseId,
      name: caseId,
      required: true,
      matcher: { type: 'SALE' },
      expect: { latest: { statusIn: ['CAPTURED'] } }
    }))
  };
}

const config = {
  version: 1,
  environment: 'sandbox',
  auth: { mode: 'app-credentials', appId: 'a', appKey: 'b', apiVersion: '2021-03-22' },
  account: {},
  polling: { intervalMs: 1000, lookbackMinutes: 10, overlapSeconds: 30, pageSize: 100, order: 'DESC' },
  matching: { defaultStrategy: 'composite', requireReference: false, timeSkewSeconds: 60 },
  output: { format: 'terminal', saveJson: true, saveJUnit: false },
  packs: {}
} as unknown as ObserverConfig;

describe('ids', () => {
  it('builds an address from a pack id and a local case id', () => {
    expect(caseAddress('global-core', 'basic-sale')).toBe('global-core:basic-sale');
  });

  it('is idempotent, so re-addressing an address never double-prefixes it', () => {
    const once = caseAddress('global-core', 'basic-sale');
    expect(caseAddress('global-core', once)).toBe(once);
    expect(caseAddress('global-core', caseAddress('global-core', once))).toBe(once);
  });

  it('splits an address back into its parts', () => {
    expect(packIdOf('global-core:basic-sale')).toBe('global-core');
    expect(localCaseId('global-core:basic-sale')).toBe('basic-sale');
    expect(localCaseId('basic-sale')).toBe('basic-sale');
    expect(packIdOf('basic-sale')).toBeUndefined();
  });

  it('rejects inputs that are not fully qualified addresses', () => {
    expect(parseCaseAddress('basic-sale')).toBeUndefined();
    expect(parseCaseAddress('global-core:')).toBeUndefined();
    expect(isCaseAddress('global-core:basic-sale')).toBe(true);
    expect(isCaseAddress('basic-sale')).toBe(false);
  });
});

describe('identity: catalog and results agree', () => {
  it('leaves resolved case ids local so they are namespaced exactly once', () => {
    const graph = new Map([['global-core', pack('global-core', ['basic-sale'])]]);
    const resolved = resolveInheritedPack('global-core', graph);
    expect(resolved.cases.map((c) => c.id)).toEqual(['basic-sale']);
  });

  it('produces single-prefixed addresses in engine state (regression: pack:pack:case)', () => {
    const graph = new Map([['global-core', pack('global-core', ['basic-sale'])]]);
    const resolved = resolveInheritedPack('global-core', graph);

    const engine = new CertificationEngine(
      config,
      [resolved],
      new StubGpApiClient({} as never),
      {},
      {}
    );

    const addresses = engine.getCaseStates().map((s) => s.namespacedId);
    expect(addresses).toEqual(['global-core:basic-sale']);
    for (const address of addresses) {
      expect(address.split(':')).toHaveLength(2);
    }
  });

  it('keeps addresses single-prefixed through an inheritance chain', () => {
    const graph = new Map([
      ['base', pack('base', ['shared'])],
      ['child', pack('child', ['own'], ['base'])]
    ]);
    const resolved = resolveInheritedPack('child', graph);

    const engine = new CertificationEngine(config, [resolved], new StubGpApiClient({} as never), {}, {});
    const addresses = engine.getCaseStates().map((s) => s.namespacedId).sort();

    expect(addresses).toEqual(['child:own', 'child:shared']);
  });

  it('detects circular pack inheritance instead of recursing forever', () => {
    const graph = new Map([
      ['a', pack('a', ['x'], ['b'])],
      ['b', pack('b', ['y'], ['a'])]
    ]);
    expect(() => resolveInheritedPack('a', graph)).toThrow(/Circular pack inheritance/);
  });
});
