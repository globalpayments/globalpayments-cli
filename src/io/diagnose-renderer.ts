import pc from 'picocolors';
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
  if (status === 'pass') return pc.green('✓');
  if (status === 'fail') return pc.red('✗');
  return pc.gray('○');
}

function renderNearMiss(near: NearMiss, log: (...args: unknown[]) => void): void {
  const label = near.reference ? `${near.transactionId} (ref "${near.reference}")` : near.transactionId;
  log(
    `    ${pc.bold('closest observed:')} ${pc.cyan(label)} ` +
      pc.gray(`— ${near.fieldsMatched}/${near.fieldsCompared} matcher fields, ${Math.round(near.score * 100)}%`)
  );

  for (const field of near.matchedFields) {
    log(`      ${pc.green('✓')} ${field}`);
  }
  for (const delta of near.mismatchedFields) {
    const verb = delta.comparison === 'startsWith' ? 'starts with' : '';
    log(
      `      ${pc.red('✗')} ${delta.field}  ${pc.gray(`expected${verb ? ` ${verb}` : ''}`)} ${pc.yellow(formatValue(delta.expected))}  ` +
        `${pc.gray('observed')} ${pc.red(formatValue(delta.actual))}`
    );
  }
  for (const delta of near.advisoryFields) {
    const verb = delta.comparison === 'startsWith' ? 'starts with' : '';
    log(
      `      ${pc.yellow('!')} ${delta.field}  ${pc.gray(`expected${verb ? ` ${verb}` : ''}`)} ${pc.yellow(formatValue(delta.expected))}  ` +
        `${pc.gray('observed')} ${formatValue(delta.actual)} ${pc.gray('(advisory — reference does not gate matching)')}`
    );
  }
}

function renderExpectationDeltas(deltas: FieldDelta[], log: (...args: unknown[]) => void): void {
  if (deltas.length === 0) {
    return;
  }
  log(`    ${pc.bold('expectation:')}`);
  for (const delta of deltas) {
    const icon = delta.satisfied ? pc.green('✓') : pc.red('✗');
    log(
      `      ${icon} ${delta.field}  ${pc.gray('expected one of')} ${pc.yellow(formatValue(delta.expected))}  ` +
        `${pc.gray('observed')} ${delta.satisfied ? pc.green(formatValue(delta.actual)) : pc.red(formatValue(delta.actual))}`
    );
  }
}

/** Render one case: cause, evidence, then the ordered remedy. */
export function renderDiagnosedCase(view: DiagnosedCaseView, log: (...args: unknown[]) => void): void {
  const { diagnosis } = view;

  log();
  log(`${statusIcon(view.status)} ${pc.cyan(view.address)}  ${pc.bold(pc.magenta(diagnosis.code))}`);
  log(`    ${diagnosis.summary}`);
  log(
    pc.gray(
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
    log(`    ${pc.bold(pc.yellow('to turn this green:'))}`);
    diagnosis.fixes.forEach((fix, index) => {
      log(`      ${index + 1}. ${pc.gray(`[${fix.confidence}]`)} ${fix.instruction}`);
    });
  }

  const { send, mustResultIn, notes } = diagnosis.requiredRequest;
  log();
  log(`    ${pc.bold('required request:')} ${JSON.stringify(send)}`);
  if (Object.keys(mustResultIn).length > 0) {
    log(`    ${pc.bold('must result in:')}   ${JSON.stringify(mustResultIn)}`);
  }
  for (const note of notes) {
    log(pc.gray(`    note: ${note}`));
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
  log(pc.bold('Why these cases are not passing'));
  log(`  Source:      ${pc.cyan(view.sourcePath)}`);
  log(`  Timestamp:   ${pc.cyan(view.timestamp)}`);
  log(`  Environment: ${pc.blue(view.environment)}`);
  log(
    `  Verdict:     ${view.verdict === 'passed' ? pc.green('PASSED') : pc.red('FAILED')} ` +
      pc.gray(`(${view.totals.passing}/${view.totals.cases} case(s) passing, ${view.totals.diagnosed} diagnosed)`)
  );

  if (view.cases.length === 0) {
    log();
    log(pc.green('Nothing to diagnose — every case in this result is passing.'));
    return;
  }

  for (const diagnosed of view.cases) {
    renderDiagnosedCase(diagnosed, log);
  }

  if (view.fixPlan.length > 0) {
    log();
    log(pc.bold('Fix plan'), pc.gray('(ordered; most specific first)'));
    for (const entry of view.fixPlan) {
      log(`  ${String(entry.rank).padStart(2)}. ${pc.cyan(entry.address)} ${pc.gray(`[${entry.action}]`)}`);
      log(`      ${entry.instruction}`);
    }
  }
  log();
}
