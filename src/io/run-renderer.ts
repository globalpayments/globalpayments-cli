import pc from 'picocolors';
import type { NextAction } from '../contract/envelope.js';
import type { RunResult } from '../types/domain.js';
import { formatDuration } from '../util/index.js';

export interface RunObservationLike {
  pollCycles: number;
  transactionsObserved: number;
  timedOut: boolean;
  elapsedMs: number;
  observationFailed?: boolean;
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
 *
 * Whenever a diagnosis exists, `diagnose` leads: it is the only command that reports
 * *which field* missed and what the corrected request looks like.
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
  const diagnosed = view.cases.filter((c) => c.status !== 'pass' && c.diagnosis !== undefined);

  // A failed poll invalidates every other conclusion, so it is the only action worth
  // offering. Suggesting the caller send transactions here would send them to fix an
  // integration that was never examined.
  if (view.observation.observationFailed) {
    return [
      {
        reason:
          'The certification window was never read, so no case verdict in this run is meaningful. Isolate whether config, credentials, or connectivity is at fault before changing anything.',
        command: 'globalpayments doctor --json'
      }
    ];
  }

  if (diagnosed.length > 0) {
    actions.push({
      reason: `Get the field-level cause and an ordered fix plan for all ${diagnosed.length} non-passing case(s).`,
      command: 'globalpayments diagnose --json'
    });
  }

  if (view.observation.transactionsObserved === 0) {
    actions.push({
      reason:
        'No transactions were observed in the polling window. globalpayments only observes; send the transactions this suite expects, then rerun.',
      command: `globalpayments cases list --cert ${pack} --json`
    });
  } else if (pending.length > 0) {
    actions.push({
      reason: `${pending.length} case(s) saw no matching transaction. See exactly which matcher field differed.`,
      command: `globalpayments diagnose ${pending[0]!.namespacedCaseId} --json`
    });
  }

  if (failed.length > 0) {
    actions.push({
      reason: `${failed.length} case(s) matched a transaction but violated their expectation. Inspect the first one.`,
      command: `globalpayments diagnose ${failed[0]!.namespacedCaseId} --json`
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
    `  Verdict:     ${
      view.observation.observationFailed
        ? pc.yellow('UNEVALUATED') + ' ' + pc.gray('(the window was never read)')
        : (view.verdict === 'passed' ? pc.green('PASSED') : pc.red('FAILED')) +
          ' ' +
          pc.gray(`(${view.required.passing}/${view.required.total} required passing)`)
    }`
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
      // The single highest-confidence change that would turn this case green. The
      // full field-level breakdown lives in `globalpayments diagnose`.
      const topFix = caze.diagnosis?.fixes[0];
      if (topFix) {
        log(`      ${pc.yellow('fix:')} ${topFix.instruction}`);
      }
    }
    log();
    log(pc.gray('Field-level causes and the full fix plan: ') + pc.yellow('globalpayments diagnose'));
  }

  // "Nothing was sent" and "we could not look" both show zero transactions. Only the
  // first is the caller's to act on.
  if (view.observation.observationFailed) {
    log();
    log(
      pc.yellow('The certification window was never read, so no verdict above is meaningful.') +
        '\n' +
        pc.gray('Do not change your integration in response to this. Run ') +
        pc.yellow('globalpayments doctor') +
        pc.gray(' to isolate config, credentials, or connectivity.')
    );
  } else if (view.observation.transactionsObserved === 0) {
    log();
    log(pc.yellow('No transactions were observed. globalpayments observes only; it never creates transactions.'));
  }
  if (view.observation.timedOut) {
    log(pc.yellow(`Timed out after ${formatDuration(view.observation.elapsedMs)}; results are partial.`));
  }

  log();
  log('Saved:', pc.cyan(view.artifacts.latest));
}
