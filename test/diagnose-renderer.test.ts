import { describe, it, expect } from 'vitest';
import { buildFixPlan, type DiagnosedCaseView } from '../src/io/diagnose-renderer.js';
import type { CaseDiagnosis, Fix } from '../src/types/domain.js';

function makeDiagnosis(code: CaseDiagnosis['code'], fixes: Fix[]): CaseDiagnosis {
  return {
    code,
    summary: `summary for ${code}`,
    observed: { transactionsInWindow: 1, candidatesMatched: 0 },
    fixes,
    nearMisses: [],
    expectationDeltas: [],
    requiredRequest: { send: {}, mustResultIn: {}, notes: [] }
  };
}

function makeView(address: string, code: CaseDiagnosis['code'], fixes: Fix[]): DiagnosedCaseView {
  return { address, status: 'pending', reason: 'r', diagnosis: makeDiagnosis(code, fixes) };
}

const specificFix: Fix = {
  action: 'change-request-field',
  field: 'amount',
  currentValue: 1000,
  requiredValue: 2002,
  instruction: 'Set `amount` to 2002.',
  confidence: 'high'
};

const genericFix: Fix = {
  action: 'send-transaction',
  instruction: 'Send the transaction this case describes.',
  confidence: 'high'
};

const lowFix: Fix = {
  action: 'change-request-field',
  field: 'reference',
  requiredValue: 'cert-1',
  instruction: 'Optional: align the reference.',
  confidence: 'low'
};

describe('fix plan', () => {
  it('puts actionable causes ahead of generic advice', () => {
    // "Nothing was observed" is the same sentence for every case, so it must never
    // outrank a concrete field change a caller can act on immediately.
    const plan = buildFixPlan([
      makeView('pack:no-txns', 'NO_TRANSACTIONS_OBSERVED', [genericFix]),
      makeView('pack:mismatch', 'MATCHER_MISMATCH', [specificFix]),
      makeView('pack:violated', 'EXPECTATION_VIOLATED', [specificFix])
    ]);

    expect(plan.map((entry) => entry.address)).toEqual(['pack:violated', 'pack:mismatch', 'pack:no-txns']);
  });

  it('numbers entries consecutively from 1 across all cases', () => {
    const plan = buildFixPlan([
      makeView('pack:a', 'MATCHER_MISMATCH', [specificFix, genericFix]),
      makeView('pack:b', 'MATCHER_MISMATCH', [specificFix])
    ]);

    expect(plan.map((entry) => entry.rank)).toEqual([1, 2, 3]);
  });

  it('orders fixes within a case by confidence', () => {
    const plan = buildFixPlan([makeView('pack:a', 'MATCHER_MISMATCH', [lowFix, specificFix])]);

    expect(plan.map((entry) => entry.confidence)).toEqual(['high', 'low']);
  });

  it('preserves the structured change so a caller never parses prose', () => {
    const plan = buildFixPlan([makeView('pack:a', 'MATCHER_MISMATCH', [specificFix])]);

    expect(plan[0]).toMatchObject({
      address: 'pack:a',
      action: 'change-request-field',
      field: 'amount',
      currentValue: 1000,
      requiredValue: 2002
    });
  });

  it('returns an empty plan when there is nothing to diagnose', () => {
    expect(buildFixPlan([])).toEqual([]);
  });
});
