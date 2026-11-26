import { statusMark, t } from '../ui/index.js';
import { hang, inlineCode } from '../ui/text.js';
import type { CaseDiagnosis, FieldDelta, Fix, NearMiss } from '../types/domain.js';

/**
 * Human rendering for diagnoses.
 *
 * Kept out of the command so `diagnose`, `run`, and `report` present a failure the
 * same way. The ordering is deliberate: cause first, evidence second, remedy third.
 * A reader who stops after the first two lines should still know what to change.
 */

export interface DiagnosedCaseView {
  address: string;
  status: 'pass' | 'fail' | 'pending';
  reason: string;
  diagnosis: CaseDiagnosis;
}

export interface FixPlanEntry {
  rank: number;
  address: string;
  action: Fix['action'];
  field?: string;
  currentValue?: unknown;
  requiredValue?: unknown;
  instruction: string;
  confidence: Fix['confidence'];
}

/**
 * Which diagnoses deserve attention first.
 *
 * A failed poll outranks everything: until it is repaired no other verdict in the
 * artifact means anything. After that, a specific field mismatch is immediately
 * actionable, while "nothing was observed" is the same advice repeated for every case,
 * so it sorts last no matter how many cases carry it.
 */
const CODE_PRIORITY: Record<CaseDiagnosis['code'], number> = {
  OBSERVATION_FAILED: 0,
  EXPECTATION_VIOLATED: 1,
  MATCHER_MISMATCH: 2,
  AMBIGUOUS_MATCH: 3,
  NO_NEAR_MATCH: 4,
  NO_TRANSACTIONS_OBSERVED: 5
};

const CONFIDENCE_PRIORITY: Record<Fix['confidence'], number> = { high: 0, medium: 1, low: 2 };

/**
 * Flatten every case's fixes into one ordered to-do list.
 *
 * This is the shape an automated caller wants: not "here are five failing cases,
 * each with its own object graph", but "here is the ordered list of changes to make".
 */
export function buildFixPlan(cases: DiagnosedCaseView[]): FixPlanEntry[] {
  const ordered = [...cases].sort(
    (a, b) => CODE_PRIORITY[a.diagnosis.code] - CODE_PRIORITY[b.diagnosis.code] || a.address.localeCompare(b.address)
  );

  const entries: FixPlanEntry[] = [];
  for (const view of ordered) {
    const fixes = [...view.diagnosis.fixes].sort(
      (a, b) => CONFIDENCE_PRIORITY[a.confidence] - CONFIDENCE_PRIORITY[b.confidence]
    );
    for (const fix of fixes) {
      entries.push({
        rank: entries.length + 1,
        address: view.address,
        action: fix.action,
        ...(fix.field !== undefined ? { field: fix.field } : {}),
        ...(fix.currentValue !== undefined ? { currentValue: fix.currentValue } : {}),
        ...(fix.requiredValue !== undefined ? { requiredValue: fix.requiredValue } : {}),
        instruction: fix.instruction,
        confidence: fix.confidence
      });
    }
  }

  return entries;
}

function formatValue(value: unknown): string {
  if (value === undefined) return '(absent)';
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.join(' | ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function statusIcon(status: string): string {
  if (status === 'pass') return statusMark('pass');
  if (status === 'fail') return statusMark('fail');
  return statusMark('pending');
}

function renderNearMiss(near: NearMiss, log: (...args: unknown[]) => void): void {
  const label = near.reference ? `${near.transactionId} (ref "${near.reference}")` : near.transactionId;
  log(
    `    ${t.strong('closest observed:')} ${t.accent(label)} ` +
      t.muted(`— ${near.fieldsMatched}/${near.fieldsCompared} matcher fields, ${Math.round(near.score * 100)}%`)
  );

  for (const field of near.matchedFields) {
    log(`      ${statusMark('pass')} ${field}`);
  }
  for (const delta of near.mismatchedFields) {
    const verb = delta.comparison === 'startsWith' ? 'starts with' : '';
    log(
      `      ${statusMark('fail')} ${delta.field}  ${t.muted(`expected${verb ? ` ${verb}` : ''}`)} ${t.accent(formatValue(delta.expected))}  ` +
        `${t.muted('observed')} ${t.danger(formatValue(delta.actual))}`
    );
  }
  for (const delta of near.advisoryFields) {
    const verb = delta.comparison === 'startsWith' ? 'starts with' : '';
    log(
      `      ${statusMark('warn')} ${delta.field}  ${t.muted(`expected${verb ? ` ${verb}` : ''}`)} ${t.accent(formatValue(delta.expected))}  ` +
        `${t.muted('observed')} ${formatValue(delta.actual)} ${t.muted('(advisory — reference does not gate matching)')}`
    );
  }
}

function renderExpectationDeltas(deltas: FieldDelta[], log: (...args: unknown[]) => void): void {
  if (deltas.length === 0) {
    return;
  }
  log(`    ${t.strong('expectation:')}`);
  for (const delta of deltas) {
    const icon = delta.satisfied ? statusMark('pass') : statusMark('fail');
    log(
      `      ${icon} ${delta.field}  ${t.muted('expected one of')} ${t.accent(formatValue(delta.expected))}  ` +
        `${t.muted('observed')} ${delta.satisfied ? t.success(formatValue(delta.actual)) : t.danger(formatValue(delta.actual))}`
    );
  }
}

/** Render one case: cause, evidence, then the ordered remedy. */
export function renderDiagnosedCase(view: DiagnosedCaseView, log: (...args: unknown[]) => void): void {
  const { diagnosis } = view;

  log();
  log(`${statusIcon(view.status)} ${t.accent(view.address)}  ${t.strong(t.accent(diagnosis.code))}`);
  log(`    ${diagnosis.summary}`);
  log(
    t.muted(
      `    observed ${diagnosis.observed.transactionsInWindow} transaction(s) in window, ${diagnosis.observed.candidatesMatched} matched this case`
    )
  );

  const best = diagnosis.nearMisses[0];
  if (best) {
    log();
    renderNearMiss(best, log);
  }

  if (diagnosis.expectationDeltas.length > 0) {
    log();
    renderExpectationDeltas(diagnosis.expectationDeltas, log);
  }

  if (diagnosis.fixes.length > 0) {
    log();
    log(`    ${t.heading('to make it pass:')}`);
    diagnosis.fixes.forEach((fix, index) => {
      log(`      ${index + 1}. ${t.muted(`[${fix.confidence}]`)} ${hang(inlineCode(fix.instruction), 9)}`);
    });
  }

  const { send, mustResultIn, notes } = diagnosis.requiredRequest;
  log();
  log(`    ${t.strong('required request:')} ${JSON.stringify(send)}`);
  if (Object.keys(mustResultIn).length > 0) {
    log(`    ${t.strong('must result in:')}   ${JSON.stringify(mustResultIn)}`);
  }
  for (const note of notes) {
    log(t.muted(`    note: ${note}`));
  }
}

export interface DiagnoseView {
  sourcePath: string;
  timestamp: string;
  environment: string;
  activePacks: string[];
  verdict: 'passed' | 'failed';
  totals: { cases: number; passing: number; diagnosed: number };
  /** How many diagnosed cases fall into each DiagnosisCode. */
  byCode: Record<string, number>;
  cases: DiagnosedCaseView[];
  /** Every fix across every case, flattened and ordered. Ranks start at 1. */
  fixPlan: FixPlanEntry[];
}

export function renderDiagnose(view: DiagnoseView, log: (...args: unknown[]) => void): void {
  log(t.strong('Why these cases are not passing'));
  log(`  Source:      ${t.accent(view.sourcePath)}`);
  log(`  Timestamp:   ${t.accent(view.timestamp)}`);
  log(`  Environment: ${t.accent(view.environment)}`);
  log(
    `  Verdict:     ${view.verdict === 'passed' ? t.success('PASSED') : t.danger('FAILED')} ` +
      t.muted(`(${view.totals.passing}/${view.totals.cases} case(s) passing, ${view.totals.diagnosed} diagnosed)`)
  );

  if (view.cases.length === 0) {
    log();
    log(t.success('Nothing to diagnose — every case in this result is passing.'));
    return;
  }

  for (const diagnosed of view.cases) {
    renderDiagnosedCase(diagnosed, log);
  }

  if (view.fixPlan.length > 0) {
    log();
    log(t.strong('Fix plan'), t.muted('(ordered; most specific first)'));
    for (const entry of view.fixPlan) {
      log(`  ${String(entry.rank).padStart(2)}. ${t.accent(entry.address)} ${t.muted(`[${entry.action}]`)}`);
      log(`      ${hang(inlineCode(entry.instruction), 6)}`);
    }
  }
  log();
}
