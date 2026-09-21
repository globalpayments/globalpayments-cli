import type {
  CaseDiagnosis,
  CertificationCase,
  DeltaComparison,
  FieldDelta,
  Fix,
  NearMiss,
  RequiredRequest,
  TransactionRecord
} from '../types/domain.js';
import { observedCardBrand, observedLast4 } from './matching.js';

/**
 * Builds the answer to "why is this red, and what do I change to make it green?".
 *
 * `reason` states what happened. A diagnosis states the *cause* at field level and
 * the *remedy* as an instruction about the next request — because globalpayments observes
 * rather than transacts, the remedy is never a change to this tool.
 *
 * Pure: no I/O, no network, no clock. Computed once during evaluation and persisted
 * into the run artifact, so `report` and `diagnose` stay fully offline.
 *
 * The matcher checks here mirror `matchesByStrategy` in `matching.ts`. A check that
 * disagrees with the matcher would produce a diagnosis contradicting the verdict,
 * which is worse than no diagnosis at all.
 */

export const DIAGNOSIS_CODES = {
  NO_TRANSACTIONS_OBSERVED: 'NO_TRANSACTIONS_OBSERVED',
  NO_NEAR_MATCH: 'NO_NEAR_MATCH',
  MATCHER_MISMATCH: 'MATCHER_MISMATCH',
  EXPECTATION_VIOLATED: 'EXPECTATION_VIOLATED',
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  OBSERVATION_FAILED: 'OBSERVATION_FAILED'
} as const;

export interface DiagnosisInput {
  caze: CertificationCase;
  status: 'pass' | 'fail' | 'pending';
  /** Every transaction returned by the poll, not just the ones that matched. */
  observedTransactions: TransactionRecord[];
  /** Transactions the matcher selected. */
  matches: TransactionRecord[];
  latestMatch?: TransactionRecord;
  ambiguous?: boolean;
  lookbackMinutes?: number;
  /**
   * The last poll failed, so `observedTransactions` is empty because nothing could be
   * read — not because nothing was there. Without this the caller is told to send
   * transactions when the real problem is credentials or connectivity.
   */
  pollFailed?: boolean;
}

const MAX_NEAR_MISSES = 3;

/**
 * How to reach each terminal status. Keyed by the status the case *expects*, because
 * that is the thing the caller has to produce.
 */
const EXPECTED_STATUS_HINTS: Record<string, string> = {
  CAPTURED:
    'Capture the transaction: either send the sale with capture_mode=AUTO, or send a capture against the existing authorization.',
  PREAUTHORIZED:
    'Send an authorization-only request (capture_mode=LATER). An auto-captured sale lands in CAPTURED, not PREAUTHORIZED.',
  REVERSED:
    'Send a reversal against the original transaction id while it is still authorized and uncaptured.',
  VERIFIED:
    'Send an account-verification request (a VERIFY, not a sale). Verification confirms the card without moving funds.',
  DECLINED:
    'This case expects a decline. Use the sandbox trigger card or amount in the matcher — an approving request will never satisfy it.',
  REFUNDED: 'Send a refund against the captured transaction id.'
};

/** What an observed status tells you about where the request actually ended up. */
const OBSERVED_STATUS_NOTES: Record<string, string> = {
  DECLINED: 'The gateway declined the request, so it never reached the expected state.',
  REJECTED: 'The gateway rejected the request before authorization.',
  PREAUTHORIZED: 'The request authorized successfully but was never captured.',
  INITIATED: 'The transaction has not reached a terminal state yet; poll again shortly.',
  PENDING: 'The transaction has not reached a terminal state yet; poll again shortly.',
  CAPTURED: 'The request captured immediately, skipping the intermediate state this case expects.'
};

/**
 * Statuses that mean the request never got off the ground.
 *
 * When one of these is observed, advice about *how to reach* the expected status is
 * actively misleading — telling a declined transaction to "capture" sends the caller
 * down the wrong path. The only useful remedy is to obtain an approval first.
 */
const TERMINAL_FAILURE_STATUSES = new Set(['DECLINED', 'REJECTED', 'REVERSED_DECLINED']);

interface MatcherCheck {
  field: string;
  path: string;
  comparison: DeltaComparison;
  expected: unknown;
  actual: (txn: TransactionRecord) => unknown;
  satisfied: (actual: unknown) => boolean;
  /**
   * Whether failing this check prevents the matcher from selecting the transaction.
   *
   * Only composite fields block. `matchesByStrategy` tries exact-reference, then
   * reference-prefix, then composite — and composite ignores `reference`, so a
   * reference mismatch alone can never cause a `pending` case.
   */
  blocking: boolean;
}

function equalsCheck(
  field: string,
  expected: unknown,
  read: (txn: TransactionRecord) => unknown,
  blocking = true
): MatcherCheck | undefined {
  if (expected === undefined) {
    return undefined;
  }
  return {
    field,
    path: `matcher.${field}`,
    comparison: 'equals',
    expected,
    actual: read,
    satisfied: (actual) => actual === expected,
    blocking
  };
}

/**
 * The matcher constraints this case imposes, in a form evaluable against any
 * transaction — including the ones the matcher rejected.
 */
export function buildMatcherChecks(caze: CertificationCase): MatcherCheck[] {
  const m = caze.matcher;
  const checks: Array<MatcherCheck | undefined> = [
    equalsCheck('type', m.type, (t) => t.type),
    equalsCheck('amount', m.amount, (t) => t.amount),
    equalsCheck('currency', m.currency, (t) => t.currency),
    equalsCheck('channel', m.channel, (t) => t.channel),
    equalsCheck('accountName', m.accountName, (t) => t.accountName),
    equalsCheck('cardBrand', m.cardBrand, observedCardBrand),
    equalsCheck('last4', m.last4, observedLast4),
    equalsCheck('reference', m.reference, (t) => t.reference, false),
    m.referencePrefix === undefined
      ? undefined
      : {
          field: 'reference',
          path: 'matcher.referencePrefix',
          comparison: 'startsWith' as const,
          expected: m.referencePrefix,
          actual: (t: TransactionRecord) => t.reference,
          satisfied: (actual: unknown) => typeof actual === 'string' && actual.startsWith(m.referencePrefix!),
          blocking: false
        }
  ];

  return checks.filter((check): check is MatcherCheck => check !== undefined);
}

function scoreTransaction(checks: MatcherCheck[], txn: TransactionRecord): NearMiss {
  const matchedFields: string[] = [];
  const mismatchedFields: FieldDelta[] = [];
  const advisoryFields: FieldDelta[] = [];
  let blockingCompared = 0;
  let blockingMatched = 0;

  for (const check of checks) {
    const actual = check.actual(txn);
    const satisfied = check.satisfied(actual);

    if (check.blocking) {
      blockingCompared += 1;
    }

    if (satisfied) {
      matchedFields.push(check.field);
      if (check.blocking) {
        blockingMatched += 1;
      }
      continue;
    }

    const delta: FieldDelta = {
      field: check.field,
      path: check.path,
      kind: 'matcher',
      comparison: check.comparison,
      expected: check.expected,
      actual,
      satisfied: false
    };

    if (check.blocking) {
      mismatchedFields.push(delta);
    } else {
      advisoryFields.push(delta);
    }
  }

  return {
    transactionId: txn.id,
    ...(txn.reference !== undefined ? { reference: txn.reference } : {}),
    timeCreated: txn.timeCreated,
    ...(txn.status !== undefined ? { status: txn.status } : {}),
    score: blockingCompared === 0 ? 1 : Math.round((blockingMatched / blockingCompared) * 100) / 100,
    fieldsCompared: blockingCompared,
    fieldsMatched: blockingMatched,
    matchedFields,
    mismatchedFields,
    advisoryFields
  };
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Rank observed transactions by how close they came to satisfying the matcher.
 *
 * Transactions sharing nothing with the case are excluded: "your VERIFICATION is not
 * this SALE case" is noise, not a lead.
 */
export function rankNearMisses(
  caze: CertificationCase,
  transactions: TransactionRecord[],
  limit = MAX_NEAR_MISSES
): NearMiss[] {
  const checks = buildMatcherChecks(caze);
  if (checks.length === 0) {
    return [];
  }

  return transactions
    .map((txn) => scoreTransaction(checks, txn))
    .filter((near) => near.fieldsMatched > 0 || near.advisoryFields.length > 0)
    .sort((a, b) => b.score - a.score || parseTime(b.timeCreated) - parseTime(a.timeCreated))
    .slice(0, limit);
}

function formatValue(value: unknown): string {
  if (value === undefined) return '(absent)';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

function describeTransaction(near: Pick<NearMiss, 'transactionId' | 'reference'>): string {
  return near.reference ? `id ${near.transactionId}, reference "${near.reference}"` : `id ${near.transactionId}`;
}

/** Turn each mismatched matcher field into an instruction about the next request. */
function matcherFixes(near: NearMiss): Fix[] {
  const where = describeTransaction(near);

  const blocking = near.mismatchedFields.map((delta) => {
    const instruction =
      delta.actual === undefined
        ? `The closest observed transaction (${where}) carried no \`${delta.field}\`. Send \`${delta.field}\` = ${formatValue(delta.expected)}.`
        : `Set \`${delta.field}\` to ${formatValue(delta.expected)} in the request you send. The closest observed transaction (${where}) used ${formatValue(delta.actual)}.`;

    return {
      action: 'change-request-field' as const,
      field: delta.field,
      ...(delta.actual !== undefined ? { currentValue: delta.actual } : {}),
      requiredValue: delta.expected,
      instruction,
      confidence: near.score >= 0.5 ? ('high' as const) : ('medium' as const)
    };
  });

  // Advisory only: the composite fallback ignores reference, so this never caused the
  // miss. Stated at low confidence because following it still makes matching precise.
  const advisory = near.advisoryFields.map((delta) => {
    const requirement =
      delta.comparison === 'startsWith'
        ? `starting with "${formatValue(delta.expected)}"`
        : `exactly "${formatValue(delta.expected)}"`;

    return {
      action: 'change-request-field' as const,
      field: 'reference',
      ...(delta.actual !== undefined ? { currentValue: delta.actual } : {}),
      requiredValue: delta.expected,
      instruction:
        `Optional: send \`reference\` ${requirement} (the closest observed transaction used ${formatValue(delta.actual)}). ` +
        'Reference is not required to match — the matcher falls back to composite fields — but it makes the match exact and unambiguous.',
      confidence: 'low' as const
    };
  });

  return [...blocking, ...advisory];
}

/** Per-field verdict for the transaction that matched, covering `expect.latest`. */
export function buildExpectationDeltas(
  caze: CertificationCase,
  latest: TransactionRecord | undefined
): FieldDelta[] {
  if (!latest) {
    return [];
  }

  const deltas: FieldDelta[] = [];
  const latestExpect = caze.expect.latest;

  if (latestExpect?.statusIn) {
    deltas.push({
      field: 'status',
      path: 'expect.latest.statusIn',
      kind: 'expectation',
      comparison: 'oneOf',
      expected: latestExpect.statusIn,
      actual: latest.status,
      satisfied: latestExpect.statusIn.includes(latest.status ?? '')
    });
  }

  if (latestExpect?.responseCodeIn) {
    // responseCode is absent from the /transactions list endpoint. The evaluator
    // deliberately skips the check when the field is missing, so the delta must
    // report `satisfied: true` or the diagnosis would contradict the verdict.
    deltas.push({
      field: 'responseCode',
      path: 'expect.latest.responseCodeIn',
      kind: 'expectation',
      comparison: 'oneOf',
      expected: latestExpect.responseCodeIn,
      actual: latest.responseCode,
      satisfied:
        latest.responseCode === undefined ? true : latestExpect.responseCodeIn.includes(latest.responseCode)
    });
  }

  return deltas;
}

/**
 * What the caller can actually change to turn a decline into an approval.
 *
 * In the GP sandbox approval is driven by the test card and the amount — but a case's
 * matcher usually constrains only one of them, and sometimes neither. Claiming the
 * matcher pins both would send the caller in a loop: they re-send exactly what
 * `requiredRequest.send` specifies, get the same decline, and have nothing left to try.
 * So name only the inputs this case actually fixes.
 */
function approvalGuidance(caze: CertificationCase): string {
  const pinned: string[] = [];
  if (caze.matcher.amount !== undefined) pinned.push(`amount ${caze.matcher.amount}`);
  if (caze.matcher.cardBrand !== undefined) pinned.push(`card brand ${caze.matcher.cardBrand}`);
  if (caze.matcher.last4 !== undefined) pinned.push(`card ending ${caze.matcher.last4}`);

  const base = 'In the GP sandbox the test card and the amount determine whether a request approves.';

  if (pinned.length === 0) {
    return `${base} This case's matcher constrains neither, so choose an approving test card and amount from the GP sandbox test-data documentation — any values that approve will satisfy this case.`;
  }

  return (
    `${base} This case's matcher fixes ${pinned.join(' and ')}, which you must keep exactly as specified; ` +
    'vary the remaining approval input until the request approves.'
  );
}

function expectationFixes(caze: CertificationCase, latest: TransactionRecord, deltas: FieldDelta[]): Fix[] {
  const fixes: Fix[] = [];

  for (const delta of deltas) {
    if (delta.satisfied) {
      continue;
    }

    const expectedList = Array.isArray(delta.expected) ? (delta.expected as string[]) : [];
    const primary = expectedList[0];
    const observed = typeof delta.actual === 'string' ? delta.actual : undefined;

    const parts = [
      `Transaction ${describeTransaction({ transactionId: latest.id, ...(latest.reference !== undefined ? { reference: latest.reference } : {}) })} matched this case but its \`${delta.field}\` was ${formatValue(delta.actual)}; the case requires one of ${formatValue(delta.expected)}.`
    ];

    if (delta.field === 'status') {
      const observedNote = observed ? OBSERVED_STATUS_NOTES[observed] : undefined;
      if (observedNote) parts.push(observedNote);

      if (observed && TERMINAL_FAILURE_STATUSES.has(observed) && !expectedList.includes(observed)) {
        // Do not explain how to reach CAPTURED from a decline; the transaction never
        // authorized. Getting an approval is the prerequisite for every later step.
        parts.push(`Nothing can be done with a declined transaction — re-send it so it approves first. ${approvalGuidance(caze)}`);
      } else {
        const expectedHint = primary ? EXPECTED_STATUS_HINTS[primary] : undefined;
        parts.push(expectedHint ?? `Send a request whose resulting status is one of ${formatValue(delta.expected)}.`);
      }
    } else {
      parts.push(
        `Response codes come from the gateway, not from your request shape. Re-send with inputs that produce ${formatValue(delta.expected)} — in sandbox this is usually driven by the test card and the amount.`
      );
    }

    fixes.push({
      action: 'change-transaction-outcome',
      field: delta.field,
      ...(delta.actual !== undefined ? { currentValue: delta.actual } : {}),
      requiredValue: delta.expected,
      instruction: parts.join(' '),
      confidence: 'high'
    });
  }

  return fixes;
}

/** The request shape the case is asking for, assembled from matcher + expect. */
export function buildRequiredRequest(caze: CertificationCase): RequiredRequest {
  const m = caze.matcher;
  const send: Record<string, unknown> = {};
  const notes: string[] = [];

  if (m.type !== undefined) send.type = m.type;
  if (m.channel !== undefined) send.channel = m.channel;
  if (m.amount !== undefined) send.amount = m.amount;
  if (m.currency !== undefined) send.currency = m.currency;
  if (m.accountName !== undefined) send.accountName = m.accountName;
  if (m.cardBrand !== undefined) send.cardBrand = m.cardBrand;
  if (m.last4 !== undefined) send.last4 = m.last4;
  if (m.reference !== undefined) send.reference = m.reference;
  if (m.referencePrefix !== undefined) send.referenceStartsWith = m.referencePrefix;

  const mustResultIn: Record<string, unknown> = {};
  if (caze.expect.latest?.statusIn) mustResultIn.statusIn = caze.expect.latest.statusIn;
  if (caze.expect.latest?.responseCodeIn) mustResultIn.responseCodeIn = caze.expect.latest.responseCodeIn;
  if (caze.expect.sequence?.statusInOrder) mustResultIn.statusInOrder = caze.expect.sequence.statusInOrder;
  if (caze.expect.aggregate?.minMatches !== undefined) mustResultIn.minMatches = caze.expect.aggregate.minMatches;

  if (m.amount !== undefined) {
    notes.push(
      `The amount ${m.amount} is part of the matcher, not a suggestion. In the GP sandbox the amount frequently selects the outcome, so sending a different amount both misses this case and may produce a different result.`
    );
  }
  if (m.reference !== undefined) {
    notes.push(`Set the request reference to exactly "${m.reference}" so the match is unambiguous.`);
  }
  if (caze.observability === 'manual') {
    notes.push('This case is marked observability: manual — the /transactions feed cannot confirm it on its own.');
  }
  if (caze.scenario) {
    notes.push(caze.scenario);
  }

  return { send, mustResultIn, notes };
}

/**
 * Explain a non-passing case.
 *
 * Returns `undefined` for a passing case: there is nothing to fix, and an empty
 * diagnosis on every green case would be noise in the artifact.
 */
export function diagnoseCase(input: DiagnosisInput): CaseDiagnosis | undefined {
  if (input.status === 'pass') {
    return undefined;
  }

  const { caze, observedTransactions, matches, latestMatch } = input;
  const requiredRequest = buildRequiredRequest(caze);
  const observed = {
    transactionsInWindow: observedTransactions.length,
    candidatesMatched: matches.length
  };

  const sendFix: Fix = {
    action: 'send-transaction',
    instruction:
      `Send the transaction this case describes: ${JSON.stringify(requiredRequest.send)}` +
      (Object.keys(requiredRequest.mustResultIn).length > 0
        ? `, which must result in ${JSON.stringify(requiredRequest.mustResultIn)}.`
        : '.') +
      ' globalpayments only observes; it never creates transactions.',
    confidence: 'high'
  };

  const widenFix: Fix = {
    action: 'widen-window',
    field: 'polling.lookbackMinutes',
    ...(input.lookbackMinutes !== undefined ? { currentValue: input.lookbackMinutes } : {}),
    instruction:
      `If you already sent it, it fell outside the polling window` +
      (input.lookbackMinutes !== undefined ? ` (last ${input.lookbackMinutes} minute(s))` : '') +
      '. Increase polling.lookbackMinutes, or re-send the transaction and rerun.',
    confidence: 'medium'
  };

  if (input.ambiguous) {
    return {
      code: DIAGNOSIS_CODES.AMBIGUOUS_MATCH,
      summary: `${matches.length} observed transactions matched this case with the same timestamp, so "latest match wins" cannot pick one.`,
      observed,
      fixes: [
        {
          action: 'disambiguate',
          instruction:
            'Two or more equally recent transactions satisfy this matcher. Re-send the scenario once, on its own, with a distinct reference so exactly one transaction is the newest match — or narrow polling.lookbackMinutes so earlier duplicates fall out of the window.',
          confidence: 'high'
        }
      ],
      nearMisses: rankNearMisses(caze, matches),
      expectationDeltas: buildExpectationDeltas(caze, latestMatch),
      requiredRequest
    };
  }

  if (input.status === 'fail' && latestMatch) {
    const expectationDeltas = buildExpectationDeltas(caze, latestMatch);
    const violated = expectationDeltas.filter((delta) => !delta.satisfied);

    return {
      code: DIAGNOSIS_CODES.EXPECTATION_VIOLATED,
      summary:
        violated.length > 0
          ? `A transaction matched this case, but ${violated.map((d) => `\`${d.field}\` was ${formatValue(d.actual)} (expected one of ${formatValue(d.expected)})`).join(' and ')}.`
          : 'A transaction matched this case but did not satisfy its expectation.',
      observed,
      fixes: expectationFixes(caze, latestMatch, expectationDeltas),
      nearMisses: rankNearMisses(caze, matches),
      expectationDeltas,
      requiredRequest
    };
  }

  // Everything below is `pending`: the matcher selected nothing.
  if (input.pollFailed) {
    return {
      code: DIAGNOSIS_CODES.OBSERVATION_FAILED,
      summary:
        'The poll failed, so the window could not be read. Nothing is known about this case — its status is unevaluated, not disproved.',
      observed,
      fixes: [
        {
          action: 'repair-connection',
          instruction:
            'Do not send transactions in response to this. globalpayments could not reach the GP API, so no result here is meaningful. Run `globalpayments doctor --json` to isolate whether config, credentials, or connectivity is at fault, then rerun.',
          confidence: 'high'
        }
      ],
      nearMisses: [],
      expectationDeltas: [],
      requiredRequest
    };
  }

  if (observedTransactions.length === 0) {
    return {
      code: DIAGNOSIS_CODES.NO_TRANSACTIONS_OBSERVED,
      summary:
        'No transactions at all were visible in the polling window, so this case had nothing to judge. This is not a tool failure.',
      observed,
      fixes: [sendFix, widenFix],
      nearMisses: [],
      expectationDeltas: [],
      requiredRequest
    };
  }

  const ranked = rankNearMisses(caze, observedTransactions);
  // Only a transaction with a blocking mismatch is a usable lead. One without would
  // mean the matcher should have selected it — a contradiction, not advice — so it is
  // never reported as the reason for a miss.
  const leads = ranked.filter((near) => near.mismatchedFields.length > 0);
  const best = leads[0];

  if (!best) {
    return {
      code: DIAGNOSIS_CODES.NO_NEAR_MATCH,
      summary: `${observedTransactions.length} transaction(s) were observed, but none shares a field with this case's matcher. The scenario this case describes has not been sent.`,
      observed,
      fixes: [sendFix, widenFix],
      nearMisses: [],
      expectationDeltas: [],
      requiredRequest
    };
  }

  const missingFields = best.mismatchedFields.map((delta) => delta.field);

  return {
    code: DIAGNOSIS_CODES.MATCHER_MISMATCH,
    summary: `No transaction matched. The closest one (${describeTransaction(best)}) satisfied ${best.fieldsMatched} of ${best.fieldsCompared} matcher field(s); ${missingFields.map((f) => `\`${f}\``).join(', ')} differ${missingFields.length === 1 ? 's' : ''}.`,
    observed,
    fixes: [...matcherFixes(best), sendFix],
    nearMisses: leads,
    expectationDeltas: [],
    requiredRequest
  };
}
