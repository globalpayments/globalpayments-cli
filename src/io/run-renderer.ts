import pc from 'picocolors';
import type { NextAction } from '../contract/envelope.js';
import type { RunResult } from '../types/domain.js';
import { formatDuration } from '../util/index.js';

export interface RunObservationLike {
  pollCycles: number;
  transactionsObserved: number;
  timedOut: boolean;
  elapsedMs: number;
}

export interface RunViewModel extends RunResult {
  observation: RunObservationLike;
  artifacts: { latest: string; history: string };
}

/**
 * Suggest the next command based on *why* the run ended where it did.
 *
 * The three failure shapes are meaningfully different and lead to different actions:
 * nothing observed at all (send transactions), matches that violated expectations
 * (inspect the case), or a clean pass (archive the report).
 */
export function buildRunNextActions(view: RunViewModel): NextAction[] {
  const actions: NextAction[] = [];
  const pack = view.activePacks[0] ?? '<packId>';

  if (view.verdict === 'passed') {
    actions.push({
      reason: 'Re-read the persisted result later without re-running.',
      command: 'globalpayments report --json'
    });
    return actions;
  }

  const pending = view.cases.filter((c) => c.status === 'pending');
  const failed = view.cases.filter((c) => c.status === 'fail');

  if (view.observation.transactionsObserved === 0) {
    actions.push({
      reason:
        'No transactions were observed in the polling window. globalpayments only observes; send the transactions this suite expects, then rerun.',
      command: `globalpayments cases list --cert ${pack} --json`
    });
  } else if (pending.length > 0) {
    actions.push({
      reason: `${pending.length} case(s) saw no matching transaction. Compare their matchers against what you sent.`,
      command: `globalpayments cases show ${pending[0]!.namespacedCaseId} --json`
    });
  }

  if (failed.length > 0) {
    actions.push({
      reason: `${failed.length} case(s) matched a transaction but violated their expectation. Inspect the first one.`,
      command: `globalpayments cases show ${failed[0]!.namespacedCaseId} --json`
    });
  }

  if (view.observation.timedOut) {
    actions.push({
      reason: 'The run hit its timeout before all required cases passed. Watch live instead of polling once.',
      command: `globalpayments watch --cert ${pack}`
    });
  }

  return actions;
}

function statusIcon(status: string): string {
  if (status === 'pass') return pc.green('✓');
  if (status === 'fail') return pc.red('✗');
  return pc.gray('○');
}

/** Human-facing summary. Only ever called when `--json` was not supplied. */
export function renderRunSummary(view: RunViewModel, log: (...args: unknown[]) => void): void {
  log();
  log(pc.bold('Certification result'));
  log(`  Environment: ${pc.blue(view.environment)}`);
  log(`  Packs:       ${pc.cyan(view.activePacks.join(', '))}`);
  log(
    `  Verdict:     ${view.verdict === 'passed' ? pc.green('PASSED') : pc.red('FAILED')} ` +
      pc.gray(`(${view.required.passing}/${view.required.total} required passing)`)
  );
  log(
    `  Cases:       ${pc.green(`${view.summary.pass} pass`)}, ${pc.red(`${view.summary.fail} fail`)}, ` +
      `${pc.gray(`${view.summary.pending} pending`)} of ${view.summary.total}`
  );
  log(
    `  Observed:    ${view.observation.transactionsObserved} transaction(s) over ` +
      `${view.observation.pollCycles} cycle(s) in ${formatDuration(view.observation.elapsedMs)}`
  );

  const notPassing = view.cases.filter((c) => c.status !== 'pass');
  if (notPassing.length > 0) {
    log();
    log(pc.bold('Not passing:'));
    for (const caze of notPassing) {
      log(`  ${statusIcon(caze.status)} ${pc.cyan(caze.namespacedCaseId)} — ${caze.reason}`);
    }
  }

  if (view.observation.transactionsObserved === 0) {
    log();
    log(pc.yellow('No transactions were observed. globalpayments observes only; it never creates transactions.'));
  }
  if (view.observation.timedOut) {
    log(pc.yellow(`Timed out after ${formatDuration(view.observation.elapsedMs)}; results are partial.`));
  }

  log();
  log('Saved:', pc.cyan(view.artifacts.latest));
}
