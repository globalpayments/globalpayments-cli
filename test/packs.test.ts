import { describe, expect, it } from 'vitest';
import { resolveActivePacks, resolveInheritedPack } from '../src/core/packs.js';
import type { CertificationPack, ObserverConfig } from '../src/types/domain.js';

describe('packs', () => {
  it('merges active packs from config, profile, and cli flags', () => {
    const config: ObserverConfig = {
      version: 1,
      environment: 'sandbox',
      auth: {
        mode: 'app-credentials',
        appId: 'id',
        appKey: 'key',
        apiVersion: '2021-03-22'
      },
      account: {
        accountName: 'test-account'
      },
      polling: {
        intervalMs: 5000,
        lookbackMinutes: 15,
        overlapSeconds: 5,
        pageSize: 100,
        order: 'DESC'
      },
      matching: {
        defaultStrategy: 'reference',
        requireReference: false,
        timeSkewSeconds: 30
      },
      output: {
        format: 'table',
        saveJson: true,
        saveJUnit: false
      },
      packs: {
        directory: './packs'
      },
      activePacks: ['global-core'],
      profiles: {
        retail: {
          packs: ['us-retail']
        }
      }
    };

    const resolved = resolveActivePacks(config, ['feature-3ds', 'global-core'], 'retail');
    expect(resolved).toEqual(['global-core', 'us-retail', 'feature-3ds']);
  });

  it('applies child overrides on inherited case ids and namespaces them', () => {
    const base: CertificationPack = {
      id: 'global-core',
      name: 'Global Core',
      version: '1.0.0',
      metadata: { region: 'global' },
      casesDirectory: 'cases',
      cases: [
        {
          id: 'sale-approved',
          name: 'Base title',
          required: true,
          matcher: { type: 'SALE' },
          expect: { latest: { statusIn: ['CAPTURED'] } }
        }
      ]
    };

    const child: CertificationPack = {
      id: 'us-retail',
      name: 'US Retail',
      version: '1.0.0',
      extends: ['global-core'],
      metadata: { channel: 'card-present' },
      casesDirectory: 'cases',
      cases: [
        {
          id: 'sale-approved',
          name: 'Override title',
          required: true,
          matcher: { type: 'SALE', currency: 'USD' },
          expect: { latest: { statusIn: ['CAPTURED'] } }
        },
        {
          id: 'refund-approved',
          name: 'Refund approved',
          required: true,
          matcher: { type: 'REFUND' },
          expect: { latest: { statusIn: ['CAPTURED'] } }
        }
      ]
    };

    const graph = new Map<string, CertificationPack>([
      ['global-core', base],
      ['us-retail', child]
    ]);

    const resolved = resolveInheritedPack('us-retail', graph);
    expect(resolved.cases).toHaveLength(2);
    // Cases should be namespaced with pack ID
    expect(resolved.cases.find((c) => c.id === 'us-retail:sale-approved')?.name).toBe('Override title');
    expect(resolved.cases.find((c) => c.id === 'us-retail:refund-approved')).toBeDefined();
    expect(resolved.metadata).toEqual({ region: 'global', channel: 'card-present' });
  });

  it('merges metadata from parent and child packs', () => {
    const parent: CertificationPack = {
      id: 'base',
      name: 'Base',
      version: '1.0.0',
      metadata: { region: 'us', industry: 'retail' },
      casesDirectory: 'cases',
      cases: []
    };

    const child: CertificationPack = {
      id: 'child',
      name: 'Child',
      version: '1.0.0',
      extends: ['base'],
      metadata: { industry: 'ecommerce', channel: 'online' },
      casesDirectory: 'cases',
      cases: []
    };

    const graph = new Map<string, CertificationPack>([
      ['base', parent],
      ['child', child]
    ]);

    const resolved = resolveInheritedPack('child', graph);
    expect(resolved.metadata).toEqual({
      region: 'us',
      industry: 'ecommerce',
      channel: 'online'
    });
  });

  it('merges tags from parent and child packs', () => {
    const parent: CertificationPack = {
      id: 'base',
      name: 'Base',
      version: '1.0.0',
      tags: ['core', 'production'],
      casesDirectory: 'cases',
      cases: []
    };

    const child: CertificationPack = {
      id: 'child',
      name: 'Child',
      version: '1.0.0',
      extends: ['base'],
      tags: ['feature', 'production'],
      casesDirectory: 'cases',
      cases: []
    };

    const graph = new Map<string, CertificationPack>([
      ['base', parent],
      ['child', child]
    ]);

    const resolved = resolveInheritedPack('child', graph);
    expect(new Set(resolved.tags)).toEqual(new Set(['core', 'production', 'feature']));
  });

  it('handles multi-level inheritance', () => {
    const grandparent: CertificationPack = {
      id: 'grandparent',
      name: 'Grandparent',
      version: '1.0.0',
      casesDirectory: 'cases',
      cases: [
        {
          id: 'case-a',
          name: 'Case A',
          required: true,
          matcher: { type: 'SALE' },
          expect: { latest: { statusIn: ['CAPTURED'] } }
        }
      ]
    };

    const parent: CertificationPack = {
      id: 'parent',
      name: 'Parent',
      version: '1.0.0',
      extends: ['grandparent'],
      casesDirectory: 'cases',
      cases: [
        {
          id: 'case-b',
          name: 'Case B',
          required: true,
          matcher: { type: 'REFUND' },
          expect: { latest: { statusIn: ['CAPTURED'] } }
        }
      ]
    };

    const child: CertificationPack = {
      id: 'child',
      name: 'Child',
      version: '1.0.0',
      extends: ['parent'],
      casesDirectory: 'cases',
      cases: [
        {
          id: 'case-a',
          name: 'Case A Override',
          required: false,
          matcher: { type: 'SALE', currency: 'USD' },
          expect: { latest: { statusIn: ['CAPTURED'] } }
        }
      ]
    };

    const graph = new Map<string, CertificationPack>([
      ['grandparent', grandparent],
      ['parent', parent],
      ['child', child]
    ]);

    const resolved = resolveInheritedPack('child', graph);
    expect(resolved.cases).toHaveLength(2);
    const caseA = resolved.cases.find((c) => c.id === 'child:case-a');
    const caseB = resolved.cases.find((c) => c.id === 'child:case-b');
    expect(caseA?.name).toBe('Case A Override');
    expect(caseA?.required).toBe(false);
    expect(caseB?.name).toBe('Case B');
  });

  it('throws error for non-existent pack', () => {
    const graph = new Map<string, CertificationPack>();
    expect(() => {
      resolveInheritedPack('non-existent', graph);
    }).toThrow('Pack not found: non-existent');
  });
});
