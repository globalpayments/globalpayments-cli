import { describe, expect, it } from 'vitest';
import { buildRunNextActions, renderRunSummary, type RunViewModel } from '../src/io/run-renderer.js';
import { renderClassicWatchFrame } from '../src/io/watch-renderer.js';

// An actions-only run reads /actions and never /transactions, so a transaction count
// alone would report an empty window even when every case saw its request.
const view = (overrides: Partial<RunViewModel['observation']>, status: 'pass' | 'pending'): RunViewModel =>
  ({
    verdict: status === 'pass' ? 'passed' : 'failed',
    environment: 'sandbox',
    activePacks: ['global-3ds'],
    summary: { pass: status === 'pass' ? 1 : 0, fail: 0, pending: status === 'pending' ? 1 : 0, total: 1 },
    required: { passing: status === 'pass' ? 1 : 0, failing: status === 'pass' ? 0 : 1, total: 1 },
    cases: [
      {
        namespacedCaseId: 'global-3ds:initiate',
        status,
        diagnosis: status === 'pending' ? { code: 'MATCHER_MISMATCH', summary: 'x', fixes: [] } : undefined
      }
    ],
    observation: { pollCycles: 2, transactionsObserved: 0, actionsObserved: 0, timedOut: false, elapsedMs: 10, ...overrides },
    artifacts: { latest: 'a', history: 'b' }
  }) as unknown as RunViewModel;

const summary = (v: RunViewModel): string => {
  const lines: string[] = [];
  renderRunSummary(v, (...args: unknown[]) => lines.push(args.map(String).join(' ')));
  return lines.join('\n');
};

describe('actions observed by a run', () => {
  it('reports actions and does not claim nothing was observed', () => {
    const text = summary(view({ actionsObserved: 7 }, 'pass'));

    expect(text).toContain('0 transaction(s), 7 action(s) over 2 cycle(s)');
    expect(text).not.toMatch(/No transactions were observed/);
  });

  it('points a pending actions case at diagnose instead of telling the caller to send transactions', () => {
    const actions = buildRunNextActions(view({ actionsObserved: 7 }, 'pending'));

    expect(actions[0]!.command).toBe('globalpayments diagnose --json');
    expect(JSON.stringify(actions)).not.toMatch(/send the transactions/i);
    expect(actions.map((a) => a.command)).toContain('globalpayments diagnose global-3ds:initiate --json');
  });

  it('still reports an empty window when neither feed returned anything', () => {
    const text = summary(view({}, 'pending'));

    expect(text).toMatch(/No transactions were observed/);
    expect(JSON.stringify(buildRunNextActions(view({}, 'pending')))).toMatch(/send the transactions/i);
  });

  it('treats a result saved before actionsObserved existed as transactions only', () => {
    const text = summary(view({ transactionsObserved: 3, actionsObserved: undefined }, 'pass'));

    expect(text).toContain('3 transaction(s) over 2 cycle(s)');
    expect(text).not.toMatch(/, \d+ action\(s\)/);
  });
});

describe('watch frame for the actions feed', () => {
  const frame = (transactionsFetched: number, actionsFetched?: number): string =>
    renderClassicWatchFrame({
      cycleNumber: 3,
      transactionsFetched,
      ...(actionsFetched === undefined ? {} : { actionsFetched }),
      cases: [],
      caseDefinitions: new Map()
    });

  it('shows the action count and no empty-window warning when actions were read', () => {
    const text = frame(0, 12);

    expect(text).toContain('0 transaction(s), 12 action(s) fetched');
    expect(text).not.toMatch(/No transactions/);
  });

  it('warns when both feeds were empty', () => {
    expect(frame(0, 0)).toContain('No transactions or actions found in this polling window.');
  });

  it('keeps the transactions-only line unchanged', () => {
    const text = frame(4, 0);

    expect(text).toContain('4 transaction(s) fetched');
    expect(text).not.toMatch(/, \d+ action\(s\)/);
  });
});
