import { describe, expect, it } from 'vitest';
import { buildCaseDetail } from '../src/io/case-details.js';
import type { CaseRunState } from '../src/core/engine.js';
import type { CertificationCase } from '../src/types/domain.js';

function createCase(): CertificationCase {
  return {
    id: 'global-core:sale-approved',
    name: 'Sale approved',
    scenario: 'Customer submits an approved sale for 10.00 USD.',
    required: true,
    matcher: {
      type: 'SALE',
      amount: 1000,
      currency: 'USD'
    },
    expect: {
      latest: {
        statusIn: ['CAPTURED'],
        responseCodeIn: ['SUCCESS']
      }
    }
  };
}

function createState(overrides: Partial<CaseRunState>): CaseRunState {
  return {
    namespacedId: 'global-core:sale-approved',
    packId: 'global-core',
    caseId: 'global-core:sale-approved',
    status: 'pending',
    reason: 'No matching transactions found in current window',
    matchedCount: 0,
    ...overrides
  };
}

describe('case details', () => {
  it('shows scenario and expected values for pending cases without submitted values', () => {
    const detail = buildCaseDetail(createCase(), createState({ status: 'pending' }));

    expect(detail.scenario).toBe('Customer submits an approved sale for 10.00 USD.');
    expect(detail.expectedValues).toEqual(
      expect.arrayContaining([
        { label: 'amount', value: 1000 },
        { label: 'currency', value: 'USD' },
        { label: 'status in', value: ['CAPTURED'] }
      ])
    );
    expect(detail.sentValues).toEqual([]);
    expect(detail.comparisons).toEqual([]);
  });

  it('shows expected vs submitted comparison rows for failed cases', () => {
    const detail = buildCaseDetail(
      createCase(),
      createState({
        status: 'fail',
        reason: 'Latest match failed',
        latestMatch: {
          id: 'txn-1',
          timeCreated: '2026-09-02T12:00:00.000Z',
          type: 'SALE',
          amount: 10,
          currency: 'usd',
          status: 'DECLINED',
          responseCode: 'DECLINED'
        },
        matchedCount: 1
      })
    );

    expect(detail.sentValues).toEqual(expect.arrayContaining([{ label: 'amount', value: 10 }]));
    expect(detail.comparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'amount', expected: 1000, actual: 10, status: 'changed' }),
        expect.objectContaining({ label: 'currency', expected: 'USD', actual: 'usd', status: 'changed' }),
        expect.objectContaining({ label: 'status', expected: ['CAPTURED'], actual: 'DECLINED', status: 'changed' })
      ])
    );
  });
});
