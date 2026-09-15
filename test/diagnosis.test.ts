import { describe, it, expect } from 'vitest';
import {
  DIAGNOSIS_CODES,
  buildExpectationDeltas,
  buildRequiredRequest,
  diagnoseCase,
  rankNearMisses
} from '../src/core/diagnosis.js';
import { matchCaseToTransactions } from '../src/core/matching.js';
import type { CertificationCase, TransactionRecord } from '../src/types/domain.js';

function makeCase(overrides: Partial<CertificationCase> = {}): CertificationCase {
  return {
    id: 'basic-sale-approved',
    name: 'Basic sale approved',
    required: true,
    mode: 'latest',
    matcher: { type: 'SALE', channel: 'CNP', currency: 'USD', amount: 2002 },
    expect: { latest: { statusIn: ['CAPTURED'] } },
    ...overrides
  };
}

function makeTxn(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: 'TRN_1',
    timeCreated: '2026-09-14T12:00:00.000Z',
    type: 'SALE',
    channel: 'CNP',
    currency: 'USD',
    amount: 2002,
    status: 'CAPTURED',
    ...overrides
  };
}

/** Run a case through the real matcher, then diagnose — the engine's exact path. */
function diagnoseThroughMatcher(caze: CertificationCase, observed: TransactionRecord[], lookbackMinutes = 5) {
  const matchResult = matchCaseToTransactions(observed, caze);
  const matches = matchResult.candidates;
  const latest = matchResult.latest;

  let status: 'pass' | 'fail' | 'pending' = 'pending';
  if (latest) {
    const statusIn = caze.expect.latest?.statusIn;
    status = !statusIn || statusIn.includes(latest.status ?? '') ? 'pass' : 'fail';
  }

  return diagnoseCase({
    caze,
    status,
    observedTransactions: observed,
    matches,
    ...(latest ? { latestMatch: latest } : {}),
    ambiguous: matchResult.ambiguous,
    lookbackMinutes
  });
}

describe('diagnosis: passing cases', () => {
  it('produces no diagnosis for a passing case', () => {
    const diagnosis = diagnoseThroughMatcher(makeCase(), [makeTxn()]);
    expect(diagnosis).toBeUndefined();
  });
});

describe('diagnosis: nothing observed', () => {
  it('reports NO_TRANSACTIONS_OBSERVED and tells the caller to send one', () => {
    const diagnosis = diagnoseThroughMatcher(makeCase(), []);

    expect(diagnosis?.code).toBe(DIAGNOSIS_CODES.NO_TRANSACTIONS_OBSERVED);
    expect(diagnosis?.observed).toEqual({ transactionsInWindow: 0, candidatesMatched: 0 });
    expect(diagnosis?.fixes[0]?.action).toBe('send-transaction');
    expect(diagnosis?.nearMisses).toEqual([]);
  });

  it('offers widening the window as a secondary fix, carrying the current lookback', () => {
    const diagnosis = diagnoseThroughMatcher(makeCase(), [], 7);
    const widen = diagnosis?.fixes.find((fix) => fix.action === 'widen-window');

    expect(widen?.field).toBe('polling.lookbackMinutes');
    expect(widen?.currentValue).toBe(7);
  });
});

describe('diagnosis: matcher mismatch', () => {
  it('names the exact field that differed and the value to send instead', () => {
    const observed = [makeTxn({ id: 'TRN_WRONG_AMOUNT', amount: 1000, reference: 'my-sale-1' })];
    const diagnosis = diagnoseThroughMatcher(makeCase(), observed);

    expect(diagnosis?.code).toBe(DIAGNOSIS_CODES.MATCHER_MISMATCH);

    const fix = diagnosis?.fixes[0];
    expect(fix?.action).toBe('change-request-field');
    expect(fix?.field).toBe('amount');
    expect(fix?.currentValue).toBe(1000);
    expect(fix?.requiredValue).toBe(2002);
    expect(fix?.instruction).toContain('2002');
    expect(fix?.instruction).toContain('1000');
  });

  it('scores near misses and ranks the closest transaction first', () => {
    const observed = [
      makeTxn({ id: 'TRN_FAR', type: 'REFUND', channel: 'CP', currency: 'EUR', amount: 1 }),
      makeTxn({ id: 'TRN_CLOSE', amount: 1000 })
    ];
    const diagnosis = diagnoseThroughMatcher(makeCase(), observed);
    const best = diagnosis?.nearMisses[0];

    expect(best?.transactionId).toBe('TRN_CLOSE');
    expect(best?.fieldsMatched).toBe(3);
    expect(best?.fieldsCompared).toBe(4);
    expect(best?.score).toBe(0.75);
    expect(best?.mismatchedFields.map((d) => d.field)).toEqual(['amount']);
  });

  it('excludes transactions that share nothing with the matcher', () => {
    const observed = [makeTxn({ id: 'TRN_ALIEN', type: 'REFUND', channel: 'CP', currency: 'EUR', amount: 5 })];
    expect(rankNearMisses(makeCase(), observed)).toEqual([]);
  });

  it('falls back to NO_NEAR_MATCH when observed transactions are wholly unrelated', () => {
    const observed = [makeTxn({ id: 'TRN_ALIEN', type: 'REFUND', channel: 'CP', currency: 'EUR', amount: 5 })];
    const diagnosis = diagnoseThroughMatcher(makeCase(), observed);

    expect(diagnosis?.code).toBe(DIAGNOSIS_CODES.NO_NEAR_MATCH);
    expect(diagnosis?.observed.transactionsInWindow).toBe(1);
  });

  it('treats a reference mismatch as advisory, never as the cause of a miss', () => {
    // matchesByStrategy falls back to `composite`, which ignores reference entirely.
    // A reference mismatch therefore cannot make a case pending, and the diagnosis
    // must not claim otherwise.
    const caze = makeCase({ matcher: { type: 'SALE', referencePrefix: 'cert-' } });
    const observed = [makeTxn({ reference: 'adhoc-1' })];

    expect(matchCaseToTransactions(observed, caze).candidates).toHaveLength(1);

    const near = rankNearMisses(caze, observed)[0];
    expect(near?.mismatchedFields).toEqual([]);
    expect(near?.advisoryFields.map((d) => d.path)).toEqual(['matcher.referencePrefix']);
  });

  it('offers a reference alignment as a low-confidence optional fix', () => {
    const caze = makeCase({
      matcher: { type: 'SALE', channel: 'CNP', currency: 'USD', amount: 2002, reference: 'cert-1' }
    });
    const observed = [makeTxn({ amount: 1000, reference: 'adhoc-1' })];
    const diagnosis = diagnoseThroughMatcher(caze, observed);

    expect(diagnosis?.code).toBe(DIAGNOSIS_CODES.MATCHER_MISMATCH);

    // The blocking field leads; the reference note follows and is clearly optional.
    expect(diagnosis?.fixes[0]?.field).toBe('amount');

    const referenceFix = diagnosis?.fixes.find((f) => f.field === 'reference');
    expect(referenceFix?.confidence).toBe('low');
    expect(referenceFix?.instruction).toContain('Optional');
    expect(referenceFix?.requiredValue).toBe('cert-1');
  });

  it('reads the card brand from paymentMethod when the top-level alias is absent', () => {
    const caze = makeCase({ matcher: { type: 'VERIFICATION', cardBrand: 'AMEX' } });
    const observed = [makeTxn({ type: 'VERIFICATION', paymentMethod: { cardBrand: 'VISA' } })];
    const diagnosis = diagnoseThroughMatcher(caze, observed);

    const fix = diagnosis?.fixes.find((f) => f.field === 'cardBrand');
    expect(fix?.currentValue).toBe('VISA');
    expect(fix?.requiredValue).toBe('AMEX');
  });
});

describe('diagnosis: expectation violated', () => {
  it('reports the status delta and how to reach the expected status', () => {
    const caze = makeCase({ expect: { latest: { statusIn: ['CAPTURED'] } } });
    const observed = [makeTxn({ id: 'TRN_AUTH', status: 'PREAUTHORIZED' })];
    const diagnosis = diagnoseThroughMatcher(caze, observed);

    expect(diagnosis?.code).toBe(DIAGNOSIS_CODES.EXPECTATION_VIOLATED);

    const fix = diagnosis?.fixes[0];
    expect(fix?.action).toBe('change-transaction-outcome');
    expect(fix?.field).toBe('status');
    expect(fix?.currentValue).toBe('PREAUTHORIZED');
    expect(fix?.requiredValue).toEqual(['CAPTURED']);
    expect(fix?.instruction).toContain('Capture the transaction');
  });

  it('never tells a declined transaction to capture', () => {
    // A decline never authorized, so "how to reach CAPTURED" is the wrong advice:
    // obtaining an approval is the prerequisite for every later step.
    const observed = [makeTxn({ id: 'TRN_DECLINED', status: 'DECLINED' })];
    const diagnosis = diagnoseThroughMatcher(makeCase(), observed);

    expect(diagnosis?.code).toBe(DIAGNOSIS_CODES.EXPECTATION_VIOLATED);
    expect(diagnosis?.summary).toContain('DECLINED');

    const fix = diagnosis?.fixes[0];
    expect(fix?.currentValue).toBe('DECLINED');
    expect(fix?.instruction).toContain('declined');
    expect(fix?.instruction).toContain('so it approves first');
    expect(fix?.instruction).not.toContain('Capture the transaction');
  });

  it('still explains how to reach a decline when the case expects one', () => {
    const caze = makeCase({ expect: { latest: { statusIn: ['DECLINED'] } } });
    const observed = [makeTxn({ status: 'CAPTURED' })];
    const diagnosis = diagnoseThroughMatcher(caze, observed);

    expect(diagnosis?.fixes[0]?.instruction).toContain('expects a decline');
  });

  it('tells an authorized-but-uncaptured transaction to capture', () => {
    const observed = [makeTxn({ status: 'PREAUTHORIZED' })];
    const diagnosis = diagnoseThroughMatcher(makeCase(), observed);

    expect(diagnosis?.fixes[0]?.instruction).toContain('never captured');
  });

  it('marks responseCode satisfied when the list endpoint omits it, matching the evaluator', () => {
    // The evaluator deliberately skips responseCodeIn when responseCode is absent.
    // A delta claiming otherwise would contradict the verdict.
    const caze = makeCase({ expect: { latest: { statusIn: ['CAPTURED'], responseCodeIn: ['SUCCESS'] } } });
    const deltas = buildExpectationDeltas(caze, makeTxn({ responseCode: undefined }));
    const responseDelta = deltas.find((d) => d.field === 'responseCode');

    expect(responseDelta?.satisfied).toBe(true);
  });

  it('flags responseCode when the field is present and wrong', () => {
    const caze = makeCase({ expect: { latest: { responseCodeIn: ['SUCCESS'] } } });
    const deltas = buildExpectationDeltas(caze, makeTxn({ responseCode: 'DECLINED' }));

    expect(deltas[0]?.satisfied).toBe(false);
    expect(deltas[0]?.path).toBe('expect.latest.responseCodeIn');
  });
});

describe('diagnosis: ambiguous match', () => {
  it('asks for disambiguation rather than a request-field change', () => {
    const observed = [
      makeTxn({ id: 'TRN_A', timeCreated: '2026-09-14T12:00:00.000Z' }),
      makeTxn({ id: 'TRN_B', timeCreated: '2026-09-14T12:00:00.000Z' })
    ];
    const diagnosis = diagnoseCase({
      caze: makeCase(),
      status: 'fail',
      observedTransactions: observed,
      matches: observed,
      latestMatch: observed[0]!,
      ambiguous: true,
      lookbackMinutes: 5
    });

    expect(diagnosis?.code).toBe(DIAGNOSIS_CODES.AMBIGUOUS_MATCH);
    expect(diagnosis?.fixes[0]?.action).toBe('disambiguate');
  });
});

describe('diagnosis: required request', () => {
  it('assembles the request shape and required outcome from matcher and expect', () => {
    const required = buildRequiredRequest(
      makeCase({
        matcher: { type: 'SALE', channel: 'CNP', amount: 2002, currency: 'USD', reference: 'cert-1' },
        expect: { latest: { statusIn: ['CAPTURED'], responseCodeIn: ['SUCCESS'] } }
      })
    );

    expect(required.send).toEqual({
      type: 'SALE',
      channel: 'CNP',
      amount: 2002,
      currency: 'USD',
      reference: 'cert-1'
    });
    expect(required.mustResultIn).toEqual({ statusIn: ['CAPTURED'], responseCodeIn: ['SUCCESS'] });
    expect(required.notes.some((note) => note.includes('2002'))).toBe(true);
  });

  it('renders a reference prefix as a distinct field, never as an exact reference', () => {
    const required = buildRequiredRequest(makeCase({ matcher: { referencePrefix: 'cert-' } }));

    expect(required.send.referenceStartsWith).toBe('cert-');
    expect(required.send.reference).toBeUndefined();
  });

  it('surfaces manual observability as a note', () => {
    const required = buildRequiredRequest(makeCase({ observability: 'manual' }));
    expect(required.notes.some((note) => note.includes('manual'))).toBe(true);
  });
});

describe('diagnosis: agreement with the matcher', () => {
  it('never claims a matcher field mismatched on a transaction the matcher accepted', () => {
    const caze = makeCase();
    const observed = [makeTxn({ status: 'DECLINED' })];
    const matchResult = matchCaseToTransactions(observed, caze);

    expect(matchResult.candidates).toHaveLength(1);

    const near = rankNearMisses(caze, matchResult.candidates)[0];
    expect(near?.mismatchedFields).toEqual([]);
    expect(near?.score).toBe(1);
  });

  it('scores only blocking fields, so a matched transaction always scores 1', () => {
    const caze = makeCase({
      matcher: { type: 'SALE', channel: 'CNP', currency: 'USD', amount: 2002, reference: 'cert-1' }
    });
    const observed = [makeTxn({ reference: 'something-else' })];

    expect(matchCaseToTransactions(observed, caze).candidates).toHaveLength(1);
    expect(rankNearMisses(caze, observed)[0]?.score).toBe(1);
  });

  it('reads card fields exactly as the matcher does, in both directions', () => {
    // The matcher and the diagnosis must resolve `cardBrand`/`last4` through the same
    // accessor. When they disagree, the matcher rejects a transaction the diagnosis
    // scores as satisfied, and the case is reported as "never sent" while the evidence
    // beneath it shows a perfect score.
    const caze = makeCase({ matcher: { type: 'SALE', cardBrand: 'VISA', last4: '4242' } });
    const viaPaymentMethod = [
      makeTxn({ cardBrand: undefined, last4: undefined, paymentMethod: { cardBrand: 'VISA', last4: '4242' } })
    ];

    expect(matchCaseToTransactions(viaPaymentMethod, caze).candidates).toHaveLength(1);
    expect(rankNearMisses(caze, viaPaymentMethod)[0]?.mismatchedFields).toEqual([]);

    const viaAlias = [makeTxn({ cardBrand: 'VISA', last4: '4242' })];
    expect(matchCaseToTransactions(viaAlias, caze).candidates).toHaveLength(1);
    expect(rankNearMisses(caze, viaAlias)[0]?.mismatchedFields).toEqual([]);
  });

  it('gives every rejected transaction at least one blocking mismatch to explain it', () => {
    // The reverse direction of the invariant above: if the matcher rejected it, the
    // diagnosis must be able to say which field is responsible. A rejected transaction
    // with no blocking mismatch is a contradiction the caller cannot act on.
    const caze = makeCase({
      matcher: { type: 'SALE', channel: 'CNP', currency: 'USD', amount: 2002, cardBrand: 'VISA', last4: '4242' }
    });

    const rejected = [
      makeTxn({ id: 'T1', amount: 1000 }),
      makeTxn({ id: 'T2', type: 'REFUND' }),
      makeTxn({ id: 'T3', currency: 'EUR' }),
      makeTxn({ id: 'T4', channel: 'CP' }),
      makeTxn({ id: 'T5', paymentMethod: { cardBrand: 'AMEX' } }),
      makeTxn({ id: 'T6', paymentMethod: { cardBrand: 'VISA', last4: '1111' } }),
      makeTxn({ id: 'T7', amount: undefined }),
      makeTxn({ id: 'T8', type: undefined, channel: undefined })
    ];

    for (const txn of rejected) {
      expect(matchCaseToTransactions([txn], caze).candidates).toHaveLength(0);

      const near = rankNearMisses(caze, [txn])[0];
      expect(near, `no near miss produced for ${txn.id}`).toBeDefined();
      expect(near!.mismatchedFields.length, `no blocking mismatch explains ${txn.id}`).toBeGreaterThan(0);
    }
  });

  it('never reports NO_NEAR_MATCH alongside evidence that contradicts it', () => {
    const caze = makeCase({ matcher: { type: 'SALE', cardBrand: 'VISA' } });
    const observed = [makeTxn({ type: 'REFUND', paymentMethod: { cardBrand: 'AMEX' } })];
    const diagnosis = diagnoseThroughMatcher(caze, observed);

    expect(diagnosis?.code).toBe(DIAGNOSIS_CODES.NO_NEAR_MATCH);
    expect(diagnosis?.nearMisses).toEqual([]);
  });
});

describe('diagnosis: failed poll', () => {
  it('never tells the caller to send transactions when the poll itself failed', () => {
    const diagnosis = diagnoseCase({
      caze: makeCase(),
      status: 'pending',
      observedTransactions: [],
      matches: [],
      lookbackMinutes: 5,
      pollFailed: true
    });

    expect(diagnosis?.code).toBe(DIAGNOSIS_CODES.OBSERVATION_FAILED);
    expect(diagnosis?.fixes.map((fix) => fix.action)).toEqual(['repair-connection']);
    expect(diagnosis?.fixes[0]?.instruction).toContain('doctor');
    expect(diagnosis?.summary).not.toContain('not a tool failure');
  });

  it('still reports an empty window as nothing observed when the poll succeeded', () => {
    const diagnosis = diagnoseCase({
      caze: makeCase(),
      status: 'pending',
      observedTransactions: [],
      matches: [],
      lookbackMinutes: 5,
      pollFailed: false
    });

    expect(diagnosis?.code).toBe(DIAGNOSIS_CODES.NO_TRANSACTIONS_OBSERVED);
  });
});

describe('diagnosis: approval guidance', () => {
  it('names only the approval inputs the matcher actually pins', () => {
    const caze = makeCase({ matcher: { type: 'SALE', channel: 'CNP', amount: 2002 } });
    const diagnosis = diagnoseThroughMatcher(caze, [
      makeTxn({ amount: 2002, currency: undefined, status: 'DECLINED' })
    ]);
    const instruction = diagnosis?.fixes[0]?.instruction ?? '';

    expect(instruction).toContain('amount 2002');
    expect(instruction).not.toContain('card brand');
    expect(instruction).not.toContain('constrains neither');
  });

  it('does not claim the matcher pins approval inputs when it pins none', () => {
    const caze = makeCase({ matcher: { type: 'SALE', channel: 'CNP' } });
    const diagnosis = diagnoseThroughMatcher(caze, [
      makeTxn({ currency: undefined, amount: undefined, status: 'DECLINED' })
    ]);
    const instruction = diagnosis?.fixes[0]?.instruction ?? '';

    expect(instruction).toContain('constrains neither');
    expect(instruction).not.toContain('fixes both');
  });

  it('names the card when the matcher pins the card instead of the amount', () => {
    const caze = makeCase({ matcher: { type: 'VERIFICATION', cardBrand: 'AMEX' } });
    const diagnosis = diagnoseThroughMatcher(caze, [
      makeTxn({ type: 'VERIFICATION', currency: undefined, amount: undefined, cardBrand: 'AMEX', status: 'DECLINED' })
    ]);
    const instruction = diagnosis?.fixes[0]?.instruction ?? '';

    expect(instruction).toContain('card brand AMEX');
    // The base sentence names the amount as an approval input, which is true. What it
    // must not do is claim this case's matcher pins it.
    expect(instruction).not.toContain('fixes card brand AMEX and amount');
    expect(instruction).toContain('vary the remaining approval input');
  });
});
