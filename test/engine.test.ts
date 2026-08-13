import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GpApiClient } from '../src/gpapi/client.js';
import type {
  CertificationCase,
  CertificationPack,
  EvaluatorModule,
  ObserverConfig,
  PollOrder,
  TransactionRecord
} from '../src/types/domain.js';
import type { ActionRecord, ActionsQuery } from '../src/gpapi/actions.js';
import { CertificationEngine, type StateTransition } from '../src/core/engine.js';

// Mock GpApiClient
class MockGpApiClient implements GpApiClient {
  constructor(private transactionsToReturn: TransactionRecord[] = []) {}

  async fetchRecentTransactions(): Promise<TransactionRecord[]> {
    return this.transactionsToReturn;
  }

  async fetchActions(_query: ActionsQuery): Promise<ActionRecord[]> {
    return [];
  }

  setTransactions(txns: TransactionRecord[]): void {
    this.transactionsToReturn = txns;
  }
}

// Helper to create minimal config
function createTestConfig(): ObserverConfig {
  return {
    version: 1,
    environment: 'sandbox',
    auth: {
      mode: 'app-credentials',
      appId: 'test-app',
      appKey: 'test-key',
      apiVersion: 'v1'
    },
    account: {
      accountName: 'test-account'
    },
    polling: {
      intervalMs: 5000,
      lookbackMinutes: 5,
      overlapSeconds: 30,
      pageSize: 100,
      order: 'DESC' as PollOrder
    },
    matching: {
      defaultStrategy: 'composite',
      requireReference: false,
      timeSkewSeconds: 30
    },
    output: {
      format: 'json',
      saveJson: true,
      saveJUnit: false
    },
    packs: {
      directory: '/test/packs'
    }
  };
}

// Helper to create test cases
function createTestCase(id: string, required = true): CertificationCase {
  return {
    id,
    name: `Test Case ${id}`,
    required,
    matcher: {
      reference: `ref-${id}`
    },
    expect: {
      latest: {
        statusIn: ['Captured']
      }
    }
  };
}

// Helper to create test pack
function createTestPack(id: string, cases: CertificationCase[]): CertificationPack {
  return {
    id,
    name: `Test Pack ${id}`,
    version: '1.0',
    metadata: {},
    casesDirectory: '/test/cases',
    cases
  };
}

// Helper to create test transaction
function createTestTxn(id: string, reference: string, status = 'Captured'): TransactionRecord {
  return {
    id,
    timeCreated: new Date().toISOString(),
    reference,
    type: 'Sale',
    status,
    amount: 100,
    currency: 'USD'
  };
}

describe('CertificationEngine', () => {
  let client: MockGpApiClient;
  let config: ObserverConfig;

  beforeEach(() => {
    client = new MockGpApiClient();
    config = createTestConfig();
  });

  describe('initialization', () => {
    it('initializes with empty state for all cases', () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      const states = engine.getCaseStates();
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({
        namespacedId: 'pack-1:case-1',
        caseId: 'case-1',
        packId: 'pack-1',
        status: 'pending',
        matchedCount: 0
      });
    });

    it('initializes with all cases from all packs', () => {
      const caze1 = createTestCase('case-1');
      const caze2 = createTestCase('case-2');
      const pack1 = createTestPack('pack-1', [caze1, caze2]);
      const caze3 = createTestCase('case-3');
      const pack2 = createTestPack('pack-2', [caze3]);

      const engine = new CertificationEngine(config, [pack1, pack2], client, {}, {});

      const states = engine.getCaseStates();
      expect(states).toHaveLength(3);
      expect(states.map((s) => s.namespacedId)).toEqual([
        'pack-1:case-1',
        'pack-1:case-2',
        'pack-2:case-3'
      ]);
    });
  });

  describe('runOnce', () => {
    it('evaluates all cases in a single cycle', async () => {
      const caze1 = createTestCase('case-1');
      const caze2 = createTestCase('case-2');
      const pack = createTestPack('pack-1', [caze1, caze2]);

      const txn1 = createTestTxn('txn-1', 'ref-case-1');
      const txn2 = createTestTxn('txn-2', 'ref-case-2');
      client.setTransactions([txn1, txn2]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      const result = await engine.runOnce();

      expect(result.cycleNumber).toEqual(1);
      expect(result.transactionsFetched).toEqual(2);
      expect(result.casesEvaluated).toEqual(2);
      expect(result.cases).toHaveLength(2);
    });

    it('detects state transition from pending to pass', async () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      const txn = createTestTxn('txn-1', 'ref-case-1', 'Captured');
      client.setTransactions([txn]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});
      const transitions: StateTransition[] = [];
      engine.on('stateTransition', (t: StateTransition) => transitions.push(t));

      const result = await engine.runOnce();

      expect(result.stateTransitions).toHaveLength(1);
      expect(result.stateTransitions[0]).toMatchObject({
        caseId: 'case-1',
        previousStatus: undefined,
        currentStatus: 'pass',
        isFirstEvaluation: true
      });
      expect(transitions).toHaveLength(1);
    });

    it('detects state transition from pass to fail', async () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      // First cycle: pass
      const txn1 = createTestTxn('txn-1', 'ref-case-1', 'Captured');
      client.setTransactions([txn1]);
      await engine.runOnce();

      // Second cycle: fail (transaction with different status)
      const txn2 = createTestTxn('txn-2', 'ref-case-1', 'Failed');
      client.setTransactions([txn2]);
      const result = await engine.runOnce();

      expect(result.stateTransitions).toHaveLength(1);
      expect(result.stateTransitions[0]).toMatchObject({
        caseId: 'case-1',
        previousStatus: 'pass',
        currentStatus: 'fail',
        isFirstEvaluation: false
      });
    });

    it('does not emit transition when status stays the same', async () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      const txn = createTestTxn('txn-1', 'ref-case-1', 'Captured');
      client.setTransactions([txn]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      // First cycle
      await engine.runOnce();

      // Second cycle with same result
      const result = await engine.runOnce();

      expect(result.stateTransitions).toHaveLength(0);
    });

    it('emits cycleComplete event', async () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});
      const events: unknown[] = [];
      engine.on('cycleComplete', (e: unknown) => events.push(e));

      await engine.runOnce();

      expect(events).toHaveLength(1);
      expect(events[0]!).toHaveProperty('cycleNumber', 1);
    });

    it('updates state with transaction data on match', async () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      const txn = createTestTxn('txn-123', 'ref-case-1', 'Captured');
      client.setTransactions([txn]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      const result = await engine.runOnce();

      const caseState = result.cases[0]!;
      expect(caseState.status).toEqual('pass');
      expect(caseState.latestMatch?.id).toEqual('txn-123');
      expect(caseState.matchedCount).toEqual(1);
    });

    it('marks case as pending when no matching transactions', async () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      client.setTransactions([]); // Empty

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      const result = await engine.runOnce();

      const caseState = result.cases[0]!;
      expect(caseState.status).toEqual('pending');
      expect(caseState.latestMatch).toBeUndefined();
      expect(caseState.matchedCount).toEqual(0);
    });

    it('increments cycle number on each run', async () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      const result1 = await engine.runOnce();
      const result2 = await engine.runOnce();

      expect(result1.cycleNumber).toEqual(1);
      expect(result2.cycleNumber).toEqual(2);
    });

    it('fails gracefully when latest match is ambiguous', async () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      const tiedTime = new Date().toISOString();
      client.setTransactions([
        {
          ...createTestTxn('txn-a', 'ref-case-1', 'Captured'),
          timeCreated: tiedTime
        },
        {
          ...createTestTxn('txn-b', 'ref-case-1', 'Captured'),
          timeCreated: tiedTime
        }
      ]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});
      const result = await engine.runOnce();

      expect(result.cases[0]?.status).toBe('fail');
      expect(result.cases[0]?.reason).toContain('Ambiguous matches found');
      expect(result.cases[0]?.matchedCount).toBe(2);
    });
  });

  describe('allRequiredCasesPassing', () => {
    it('returns true when all required cases are pass', async () => {
      const caze1 = createTestCase('case-1', true);
      const caze2 = createTestCase('case-2', true);
      const pack = createTestPack('pack-1', [caze1, caze2]);

      const txn1 = createTestTxn('txn-1', 'ref-case-1');
      const txn2 = createTestTxn('txn-2', 'ref-case-2');
      client.setTransactions([txn1, txn2]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      await engine.runOnce();
      expect(engine.allRequiredCasesPassing()).toBe(true);
    });

    it('returns false when any required case is fail', async () => {
      const caze1 = createTestCase('case-1', true);
      const caze2 = createTestCase('case-2', true);
      const pack = createTestPack('pack-1', [caze1, caze2]);

      // txn1 passes, but txn2 fails (has wrong status)
      const txn1 = createTestTxn('txn-1', 'ref-case-1', 'Captured');
      const txn2 = createTestTxn('txn-2', 'ref-case-2', 'Failed');
      client.setTransactions([txn1, txn2]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      await engine.runOnce();
      expect(engine.allRequiredCasesPassing()).toBe(false);
    });

    it('returns false when any required case is pending', async () => {
      const caze1 = createTestCase('case-1', true);
      const caze2 = createTestCase('case-2', true);
      const pack = createTestPack('pack-1', [caze1, caze2]);

      // No transactions, all cases pending
      client.setTransactions([]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      await engine.runOnce();
      expect(engine.allRequiredCasesPassing()).toBe(false);
    });

    it('ignores non-required cases', async () => {
      const caze1 = createTestCase('case-1', true); // required
      const caze2 = createTestCase('case-2', false); // not required
      const pack = createTestPack('pack-1', [caze1, caze2]);

      const txn1 = createTestTxn('txn-1', 'ref-case-1'); // only txn1
      client.setTransactions([txn1]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      await engine.runOnce();
      // case-1 is pass, case-2 is pending (not required, so ignored)
      expect(engine.allRequiredCasesPassing()).toBe(true);
    });
  });

  describe('allRequiredCasesEvaluated', () => {
    it('returns true when all required cases have been evaluated', async () => {
      const caze1 = createTestCase('case-1', true);
      const caze2 = createTestCase('case-2', true);
      const pack = createTestPack('pack-1', [caze1, caze2]);

      client.setTransactions([]); // Empty - will mark all as pending but evaluated

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      await engine.runOnce();
      expect(engine.allRequiredCasesEvaluated()).toBe(true);
    });

    it('returns false when required cases are still pending (not yet evaluated)', () => {
      const caze = createTestCase('case-1', true);
      const pack = createTestPack('pack-1', [caze]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      // No runOnce call, so cases are in initial pending state
      expect(engine.allRequiredCasesEvaluated()).toBe(false);
    });
  });

  describe('getCaseStates', () => {
    it('returns array of current case states', async () => {
      const caze1 = createTestCase('case-1');
      const caze2 = createTestCase('case-2');
      const pack = createTestPack('pack-1', [caze1, caze2]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      const states = engine.getCaseStates();

      expect(states).toHaveLength(2);
      expect(states[0]!.caseId).toEqual('case-1');
      expect(states[1]!.caseId).toEqual('case-2');
    });
  });

  describe('run mode', () => {
    it('executes exactly one poll cycle', async () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      const txn = createTestTxn('txn-1', 'ref-case-1');
      client.setTransactions([txn]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      const states = await engine.run();

      expect(states).toHaveLength(1);
      expect(states[0]!.status).toEqual('pass');
    });

    it('respects abort signal', async () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});
      const controller = new AbortController();
      controller.abort();

      const events: unknown[] = [];
      engine.on('runAborted', (e: unknown) => events.push(e));

      const states = await engine.run({ signal: controller.signal });

      // Should return initial pending state without running
      expect(states[0]!.status).toEqual('pending');
      expect(events).toHaveLength(1);
    });
  });

  describe('watch mode', () => {
    it('polls until all required cases pass', async () => {
      const caze = createTestCase('case-1', true);
      const pack = createTestPack('pack-1', [caze]);

      // Create config with very short polling interval for testing
      const testConfig = { ...config, polling: { ...config.polling, intervalMs: 50 } };
      const engine = new CertificationEngine(testConfig, [pack], client, {}, {});

      let callCount = 0;
      vi.spyOn(client, 'fetchRecentTransactions').mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          // First call: no match, case stays pending
          return [];
        } else {
          // Second call: match found, case becomes pass
          return [createTestTxn('txn-1', 'ref-case-1', 'Captured')];
        }
      });

      const states = await engine.watch({ maxTimeoutMs: 500 });

      expect(states[0]!.status).toEqual('pass');
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('times out after maxTimeoutMs', async () => {
      const caze = createTestCase('case-1', true);
      const pack = createTestPack('pack-1', [caze]);

      client.setTransactions([]); // Never matches, case stays pending

      // Create config with very short polling interval for testing
      const testConfig = { ...config, polling: { ...config.polling, intervalMs: 50 } };
      const engine = new CertificationEngine(testConfig, [pack], client, {}, {});

      const events: unknown[] = [];
      engine.on('watchTimeout', (e: unknown) => events.push(e));

      const startTime = Date.now();
      const states = await engine.watch({ maxTimeoutMs: 200 });
      const elapsed = Date.now() - startTime;

      expect(events).toHaveLength(1);
      expect(elapsed).toBeLessThan(500); // Should be close to timeout
      expect(states[0]!.status).toEqual('pending'); // Case never passed
    });

    it('respects abort signal', async () => {
      const caze = createTestCase('case-1', true);
      const pack = createTestPack('pack-1', [caze]);

      client.setTransactions([]); // Never matches

      // Create config with very short polling interval for testing
      const testConfig = { ...config, polling: { ...config.polling, intervalMs: 50 } };
      const engine = new CertificationEngine(testConfig, [pack], client, {}, {});

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);

      const events: unknown[] = [];
      engine.on('watchAborted', (e: unknown) => events.push(e));

      const states = await engine.watch({ maxTimeoutMs: 5000, signal: controller.signal });

      expect(events).toHaveLength(1);
      expect(events[0]!).toHaveProperty('cycleCount');
    });

    it('emits allRequiredCasesPassing event when condition met', async () => {
      const caze = createTestCase('case-1', true);
      const pack = createTestPack('pack-1', [caze]);

      const txn = createTestTxn('txn-1', 'ref-case-1', 'Captured');
      client.setTransactions([txn]);

      const engine = new CertificationEngine(config, [pack], client, {}, {});

      const events: unknown[] = [];
      engine.on('allRequiredCasesPassing', (e: unknown) => events.push(e));

      const states = await engine.watch({ maxTimeoutMs: 5000 });

      expect(events).toHaveLength(1);
      expect(states[0]!.status).toEqual('pass');
    });
  });

  describe('error handling', () => {
    it('emits error event when client fetch fails', async () => {
      const caze = createTestCase('case-1');
      const pack = createTestPack('pack-1', [caze]);

      const mockClient = {
        fetchRecentTransactions: vi.fn().mockRejectedValue(new Error('Network error'))
      } as unknown as GpApiClient;

      const engine = new CertificationEngine(config, [pack], mockClient, {}, {});

      const events: unknown[] = [];
      engine.on('error', (e: unknown) => events.push(e));

      const result = await engine.runOnce();

      expect(events).toHaveLength(1);
      expect(events[0]!).toHaveProperty('type', 'polling_error');
      // Case should be pending since no transactions were fetched
      expect(result.cases[0]!.status).toEqual('pending');
    });
  });
});
