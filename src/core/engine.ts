import { EventEmitter } from 'node:events';
import type {
  CaseDiagnosis,
  CaseEvaluationResult,
  CertificationCase,
  CertificationPack,
  EvaluatorModule,
  ObserverConfig,
  TransactionRecord
} from '../types/domain.js';
import type { GpApiClient } from '../gpapi/client.js';
import { matchCaseToTransactions } from './matching.js';
import { evaluateCase } from './evaluator.js';
import { diagnoseCase } from './diagnosis.js';
import { calculatePollingWindow } from './polling.js';
import { caseAddress } from './ids.js';

/**
 * Represents the runtime state of a single case during polling.
 */
export interface CaseRunState {
  caseId: string;
  packId: string;
  namespacedId: string;
  status: 'pass' | 'fail' | 'pending';
  reason: string;
  latestMatch?: TransactionRecord;
  matchedCount: number;
  evaluatedAt?: number;
  /** Field-level cause and remediation. Absent while passing. */
  diagnosis?: CaseDiagnosis;
}

/**
 * Represents a state change event emitted when a case transitions.
 */
export interface StateTransition {
  namespacedCaseId: string;
  packId: string;
  caseId: string;
  previousStatus?: 'pass' | 'fail' | 'pending';
  currentStatus: 'pass' | 'fail' | 'pending';
  isFirstEvaluation: boolean;
}

/**
 * Represents the in-memory engine state across all cases.
 */
export interface EngineState {
  cases: Map<string, CaseRunState>;
  lastPolledAt?: number;
  lastEvaluatedAt?: number;
  evaluationCount: number;
}

/**
 * Options for running the certification engine.
 */
export interface EngineRunOptions {
  maxTimeoutMs?: number;
  failFast?: boolean;
  signal?: AbortSignal;
}

/**
 * Results from a single engine poll cycle.
 */
export interface EnginePollResult {
  cycleNumber: number;
  transactionsFetched: number;
  casesEvaluated: number;
  stateTransitions: StateTransition[];
  cases: CaseRunState[];
  recentTransactions: TransactionRecord[];
}

/**
 * CertificationEngine orchestrates polling, matching, and evaluation.
 *
 * State model:
 * - Maintains in-memory state map for all cases
 * - Each poll cycle: fetch transactions → normalize → match → evaluate → detect transitions
 * - Emits delta events (StateTransition) when a case status changes
 * - Supports both watch mode (keep polling) and run mode (single/timeout-based)
 */
export class CertificationEngine extends EventEmitter {
  private state: EngineState;
  private cycleNumber = 0;
  private allCases: Array<{ pack: CertificationPack; case: CertificationCase }> = [];

  constructor(
    private config: ObserverConfig,
    private packs: CertificationPack[],
    private client: GpApiClient,
    private evaluators: Record<string, EvaluatorModule>,
    private packEvaluators: Record<string, Record<string, EvaluatorModule>>
  ) {
    super();
    this.state = {
      cases: new Map(),
      evaluationCount: 0
    };

    // Flatten and index all cases from all packs
    for (const pack of packs) {
      for (const caze of pack.cases) {
        const namespacedId = caseAddress(pack.id, caze.id);
        this.allCases.push({ pack, case: caze });
        this.state.cases.set(namespacedId, {
          caseId: caze.id,
          packId: pack.id,
          namespacedId,
          status: 'pending',
          reason: 'Not yet evaluated',
          matchedCount: 0
        });
      }
    }
  }

  /**
   * Get the current engine state.
   */
  getState(): EngineState {
    return this.state;
  }

  /**
   * Get a snapshot of all case states.
   */
  getCaseStates(): CaseRunState[] {
    return Array.from(this.state.cases.values());
  }

  /**
   * Run a single polling and evaluation cycle.
   * Returns the results of that cycle including state transitions.
   */
  async runOnce(): Promise<EnginePollResult> {
    this.cycleNumber += 1;
    const now = Date.now();

    // Calculate polling window
    const window = calculatePollingWindow(
      {
        lookbackMinutes: this.config.polling.lookbackMinutes,
        overlapSeconds: this.config.polling.overlapSeconds,
        pageSize: this.config.polling.pageSize,
        order: this.config.polling.order
      },
      now
    );

    // Fetch transactions from GP API
    let transactions: TransactionRecord[] = [];
    let pollFailed = false;
    try {
      transactions = await this.client.fetchRecentTransactions(window);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      pollFailed = true;
      // Deliberately NOT the reserved 'error' event: Node throws when an 'error' event
      // has no listener, which would abort the run over a condition we recover from
      // here. The cycle continues; the diagnosis reports OBSERVATION_FAILED.
      this.emit('pollError', {
        type: 'polling_error',
        message: `Failed to fetch transactions: ${msg}`,
        error
      });
      // Continue with empty transaction list; this cycle will mark all cases as pending.
      // `pollFailed` keeps the diagnosis from reporting that as "nothing was sent".
    }

    this.state.lastPolledAt = now;

    // Evaluate all cases
    const stateTransitions: StateTransition[] = [];
    for (const { pack, case: caze } of this.allCases) {
      const namespacedId = caseAddress(pack.id, caze.id);
      const previousRunState = this.state.cases.get(namespacedId)!;
      const previousStatus = previousRunState.status;

      // Match transactions to this case
      const matchResult = matchCaseToTransactions(transactions, caze);
      const matches = matchResult.candidates;

      // Get evaluator for this case and pack
      const packEvaluators = this.packEvaluators[pack.id] || this.evaluators;

      // Evaluate the case
      const evaluationResult = matchResult.ambiguous
        ? {
            namespacedCaseId: namespacedId,
            packId: pack.id,
            caseId: caze.id,
            status: 'fail' as const,
            reason: 'Ambiguous matches found: multiple equally recent transactions matched. Refine case matcher fields.',
            latestMatch: matchResult.latest,
            matchedCount: matches.length
          }
        : evaluateCase(pack, caze, matches, packEvaluators);

      // Update state
      const diagnosis = diagnoseCase({
        caze,
        status: evaluationResult.status,
        observedTransactions: transactions,
        matches,
        ...(evaluationResult.latestMatch ? { latestMatch: evaluationResult.latestMatch } : {}),
        ambiguous: matchResult.ambiguous,
        lookbackMinutes: this.config.polling.lookbackMinutes,
        pollFailed
      });

      const newRunState: CaseRunState = {
        caseId: evaluationResult.caseId,
        packId: evaluationResult.packId,
        namespacedId: evaluationResult.namespacedCaseId,
        status: evaluationResult.status,
        reason: evaluationResult.reason,
        latestMatch: evaluationResult.latestMatch,
        matchedCount: evaluationResult.matchedCount,
        evaluatedAt: now,
        ...(diagnosis ? { diagnosis } : {})
      };

      this.state.cases.set(namespacedId, newRunState);

      // Detect and emit state transitions
      if (previousStatus !== newRunState.status) {
        const transition: StateTransition = {
          namespacedCaseId: namespacedId,
          packId: pack.id,
          caseId: caze.id,
          previousStatus: previousStatus === 'pending' ? undefined : previousStatus,
          currentStatus: newRunState.status,
          isFirstEvaluation: previousStatus === 'pending' && newRunState.status !== 'pending'
        };

        stateTransitions.push(transition);
        this.emit('stateTransition', transition);
      }
    }

    this.state.lastEvaluatedAt = now;
    this.state.evaluationCount += 1;

    const result: EnginePollResult = {
      cycleNumber: this.cycleNumber,
      transactionsFetched: transactions.length,
      casesEvaluated: this.allCases.length,
      stateTransitions,
      cases: this.getCaseStates(),
      recentTransactions: transactions.slice(0, 5)
    };

    this.emit('cycleComplete', result);
    return result;
  }

  /**
   * Check if all required cases are passing.
   */
  allRequiredCasesPassing(): boolean {
    for (const { pack, case: caze } of this.allCases) {
      if (caze.required) {
        const namespacedId = caseAddress(pack.id, caze.id);
        const runState = this.state.cases.get(namespacedId);
        if (!runState || runState.status !== 'pass') {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Check if all required cases have been evaluated (i.e., runOnce has been called for them).
   */
  allRequiredCasesEvaluated(): boolean {
    for (const { pack, case: caze } of this.allCases) {
      if (caze.required) {
        const namespacedId = caseAddress(pack.id, caze.id);
        const runState = this.state.cases.get(namespacedId);
        if (!runState || !runState.evaluatedAt) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Watch mode: keep polling until timeout or all required cases pass.
   * Emits events on each cycle and returns final state when complete.
   */
  async watch(options: EngineRunOptions = {}): Promise<CaseRunState[]> {
    const startTime = Date.now();
    const timeoutMs = options.maxTimeoutMs ?? 5 * 60 * 1000; // 5 minutes default

    let pollInterval = this.config.polling.intervalMs;

    while (true) {
      // Check abort signal
      if (options.signal?.aborted) {
        this.emit('watchAborted', {
          cycleCount: this.cycleNumber,
          elapsedMs: Date.now() - startTime
        });
        break;
      }

      // Check timeout
      if (Date.now() - startTime > timeoutMs) {
        this.emit('watchTimeout', {
          cycleCount: this.cycleNumber,
          elapsedMs: Date.now() - startTime
        });
        break;
      }

      // Run one cycle
      await this.runOnce();

      // Check if all required cases are passing
      if (this.allRequiredCasesPassing()) {
        this.emit('allRequiredCasesPassing', {
          cycleCount: this.cycleNumber,
          elapsedMs: Date.now() - startTime
        });
        break;
      }

      // Wait for next poll
      await sleep(pollInterval, options.signal);
    }

    return this.getCaseStates();
  }

  /**
   * Run mode: run one cycle and return results (suitable for CI).
   */
  async run(options: EngineRunOptions = {}): Promise<CaseRunState[]> {
    // Check abort signal
    if (options.signal?.aborted) {
      this.emit('runAborted', {});
      return this.getCaseStates();
    }

    // Run one cycle
    await this.runOnce();

    return this.getCaseStates();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timeout);
      resolve();
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
