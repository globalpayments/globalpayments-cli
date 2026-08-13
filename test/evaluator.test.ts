import { describe, expect, it } from 'vitest';
import { evaluateCase, summarizeCases } from '../src/core/evaluator.js';
import type { CertificationCase, CertificationPack, TransactionRecord } from '../src/types/domain.js';

const pack: CertificationPack = {
  id: 'global-core',
  name: 'Global Core',
  version: '1.0.0',
  casesDirectory: 'cases',
  cases: []
};

const caze: CertificationCase = {
  id: 'sale-approved',
  name: 'Sale approved',
  required: true,
  matcher: { type: 'SALE' },
  expect: {
    latest: {
      statusIn: ['CAPTURED']
    }
  }
};

const olderPass: TransactionRecord = {
  id: 'old-pass',
  timeCreated: '2026-01-01T00:00:00Z',
  type: 'SALE',
  status: 'CAPTURED'
};

const newerFail: TransactionRecord = {
  id: 'new-fail',
  timeCreated: '2026-01-02T00:00:00Z',
  type: 'SALE',
  status: 'DECLINED'
};

describe('evaluator', () => {
  it('uses latest matching transaction and can flip pass to fail', () => {
    const result = evaluateCase(pack, caze, [newerFail, olderPass], {});
    expect(result.status).toBe('fail');
    expect(result.latestMatch?.id).toBe('new-fail');
    expect(result.matchedCount).toBe(2);
  });

  it('returns pending when there are no matches', () => {
    const result = evaluateCase(pack, caze, [], {});
    expect(result.status).toBe('pending');
  });

  it('allows custom script evaluators', () => {
    const customPack: CertificationPack = {
      ...pack,
      evaluators: {
        default: 'always-pass'
      }
    };

    const result = evaluateCase(customPack, caze, [newerFail], {
      'always-pass': (latest) => ({
        status: latest ? 'pass' : 'pending',
        reason: 'forced by script',
        latestMatch: latest,
        matchedCount: latest ? 1 : 0
      })
    });

    expect(result.status).toBe('pass');
    expect(result.reason).toContain('forced');
  });

  it('summarizes rollups', () => {
    const summary = summarizeCases([
      { namespacedCaseId: 'a:x', packId: 'a', caseId: 'x', status: 'pass', reason: '', matchedCount: 1 },
      { namespacedCaseId: 'a:y', packId: 'a', caseId: 'y', status: 'fail', reason: '', matchedCount: 1 },
      { namespacedCaseId: 'a:z', packId: 'a', caseId: 'z', status: 'pending', reason: '', matchedCount: 0 }
    ]);

    expect(summary).toEqual({ pass: 1, fail: 1, pending: 1, total: 3 });
  });
});
