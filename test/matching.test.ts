import { describe, expect, it } from 'vitest';
import {
  detectAmbiguousMatches,
  findMatches,
  latestMatch,
  matchCaseToTransactions,
  matchesCriteria
} from '../src/core/matching.js';
import type { CertificationCase, ObservedTxn } from '../src/core/types.js';

const caseTemplate: CertificationCase = {
  id: 'sale-approved',
  matcher: {
    type: 'SALE',
    amount: 100,
    currency: 'USD'
  }
};

const txns: ObservedTxn[] = [
  {
    id: 't1',
    timeCreated: '2026-01-01T00:00:00Z',
    type: 'SALE',
    amount: 100,
    currency: 'USD',
    status: 'CAPTURED'
  },
  {
    id: 't2',
    timeCreated: '2026-01-02T00:00:00Z',
    type: 'SALE',
    amount: 100,
    currency: 'USD',
    status: 'DECLINED'
  }
];

const firstTxn = txns[0]!;
const secondTxn = txns[1]!;

describe('matching', () => {
  it('matches all configured composite fields as AND conditions', () => {
    expect(matchesCriteria(firstTxn, caseTemplate.matcher)).toBe(true);
    expect(matchesCriteria({ ...firstTxn, amount: 200 }, caseTemplate.matcher)).toBe(false);
  });

  it('prefers exact reference matching when configured', () => {
    const caze: CertificationCase = {
      ...caseTemplate,
      matcher: { reference: 'abc-123', amount: 100 }
    };

    const result = matchCaseToTransactions([
      { ...firstTxn, id: 'tx-exact', reference: 'abc-123' },
      { ...firstTxn, id: 'tx-prefix', reference: 'abc-123-suffix' }
    ], caze);

    expect(result.strategy).toBe('exact-reference');
    expect(result.candidates.map((txn) => txn.id)).toEqual(['tx-exact']);
  });

  it('supports reference prefix matching when configured', () => {
    const caze: CertificationCase = {
      ...caseTemplate,
      matcher: { referencePrefix: 'cert-sale-' }
    };

    const result = matchCaseToTransactions([
      { ...firstTxn, id: 'tx-prefix-hit', reference: 'cert-sale-123' },
      { ...firstTxn, id: 'tx-prefix-miss', reference: 'other-123' }
    ], caze);

    expect(result.strategy).toBe('reference-prefix');
    expect(result.candidates.map((txn) => txn.id)).toEqual(['tx-prefix-hit']);
  });

  it('supports composite matching with optional card filters', () => {
    const caze: CertificationCase = {
      ...caseTemplate,
      matcher: {
        type: 'SALE',
        amount: 100,
        currency: 'USD',
        channel: 'CNP',
        accountName: 'acct-a',
        cardBrand: 'VISA',
        last4: '1111'
      }
    };

    const result = matchCaseToTransactions([
      {
        ...firstTxn,
        id: 'tx-composite-hit',
        channel: 'CNP',
        accountName: 'acct-a',
        cardBrand: 'VISA',
        last4: '1111'
      },
      {
        ...firstTxn,
        id: 'tx-composite-miss',
        channel: 'CNP',
        accountName: 'acct-a',
        cardBrand: 'MC',
        last4: '1111'
      }
    ], caze);

    expect(result.strategy).toBe('composite');
    expect(result.candidates.map((txn) => txn.id)).toEqual(['tx-composite-hit']);
  });

  it('latest transaction wins', () => {
    const matches = findMatches(txns, caseTemplate);
    expect(matches.map((t) => t.id)).toEqual([secondTxn.id, firstTxn.id]);
    expect(latestMatch(matches)?.id).toBe(secondTxn.id);
  });

  it('new failing latest transaction flips old pass to fail', () => {
    const matches = findMatches([
      {
        id: 'tx-pass-old',
        timeCreated: '2026-01-01T00:00:00Z',
        type: 'SALE',
        amount: 100,
        currency: 'USD',
        status: 'CAPTURED'
      },
      {
        id: 'tx-fail-new',
        timeCreated: '2026-01-02T00:00:00Z',
        type: 'SALE',
        amount: 100,
        currency: 'USD',
        status: 'DECLINED'
      }
    ], caseTemplate);

    expect(latestMatch(matches)?.status).toBe('DECLINED');
  });

  it('flags ambiguous when top candidates tie on timeCreated', () => {
    const matches = findMatches([
      {
        id: 'tx-a',
        timeCreated: '2026-01-02T00:00:00Z',
        type: 'SALE',
        amount: 100,
        currency: 'USD'
      },
      {
        id: 'tx-b',
        timeCreated: '2026-01-02T00:00:00Z',
        type: 'SALE',
        amount: 100,
        currency: 'USD'
      }
    ], caseTemplate);

    expect(detectAmbiguousMatches(matches)).toBe(true);
    expect(detectAmbiguousMatches([firstTxn])).toBe(false);
  });
});
