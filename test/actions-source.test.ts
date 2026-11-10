import { describe, it, expect, vi } from 'vitest';
import {
  adaptGpActionObservation,
  ActionsApiError,
  fetchRecentActionsPaginated,
  type ActionsApiDeps
} from '../src/gpapi/actions.js';
import { CertificationEngine } from '../src/core/engine.js';
import { matchCaseToTransactions } from '../src/core/matching.js';
import { buildMatcherChecks, buildRequiredRequest } from '../src/core/diagnosis.js';
import { caseSchema } from '../src/config/schema.js';
import { toGlobalPaymentsError, ERROR_CODES } from '../src/contract/errors.js';
import type { GpApiClient } from '../src/gpapi/client.js';
import type { CertificationCase, CertificationPack, ObserverConfig, TransactionRecord } from '../src/types/domain.js';

function deps(fetchImpl: typeof fetch): ActionsApiDeps {
  return {
    authProvider: { getToken: async () => ({ accessToken: 'token', metadata: {} }) } as never,
    authInput: { appId: 'observer-app', appKey: 'key', environment: 'sandbox', apiVersion: 'v1' },
    baseUrl: 'https://api.example.com/ucp',
    apiVersion: 'v1',
    fetchImpl
  };
}

function okResponse(actions: unknown[]): Response {
  return { ok: true, json: async () => ({ actions }) } as unknown as Response;
}

function action(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'ACT_1',
    type: 'PAYER_CREATE',
    resource: 'PAYERS',
    resource_id: 'PYR_1',
    resource_status: 'ACTIVE',
    http_response_code: '200',
    time_created: '2026-10-28T11:58:00.000Z',
    app_id: 'integrator-app',
    ...overrides
  };
}

const config: ObserverConfig = {
  version: 1,
  environment: 'sandbox',
  auth: { mode: 'app-credentials', appId: 'observer-app', appKey: 'key', apiVersion: 'v1' },
  account: {},
  polling: { intervalMs: 1000, lookbackMinutes: 10, overlapSeconds: 30, pageSize: 100, order: 'DESC' },
  matching: { defaultStrategy: 'composite', requireReference: false, timeSkewSeconds: 30 },
  output: { format: 'json', saveJson: false, saveJUnit: false },
  packs: {}
};

const payerCase: CertificationCase = {
  id: 'payer-create',
  name: 'Create a payer',
  required: true,
  source: 'actions',
  matcher: { type: 'PAYER_CREATE', resource: 'PAYERS' },
  expect: { latest: { statusIn: ['ACTIVE'], responseCodeIn: ['200'] } }
};

const saleCase: CertificationCase = {
  id: 'sale',
  name: 'Sale',
  required: true,
  matcher: { type: 'SALE', amount: 1000 },
  expect: { latest: { statusIn: ['CAPTURED'] } }
};

function pack(cases: CertificationCase[]): CertificationPack {
  return { id: 'pack', name: 'Pack', version: '1.0.0', casesDirectory: 'cases', cases };
}

function observedAction(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return { ...adaptGpActionObservation(action({}) as never), ...overrides };
}

describe('actions as an observation source', () => {
  describe('adaptGpActionObservation', () => {
    it('projects an action onto the observed-record shape', () => {
      const record = adaptGpActionObservation(action({ response_code: 'SUCCESS' }) as never);
      expect(record).toMatchObject({
        id: 'ACT_1',
        type: 'PAYER_CREATE',
        resource: 'PAYERS',
        status: 'ACTIVE',
        responseCode: '200',
        responseMessage: 'SUCCESS',
        reference: 'PYR_1',
        timeCreated: '2026-10-28T11:58:00.000Z'
      });
    });

    it('stringifies a numeric HTTP status so responseCodeIn compares strings', () => {
      expect(adaptGpActionObservation(action({ http_response_code: 201 }) as never).responseCode).toBe('201');
    });

    it('reads a zoneless time_created as UTC and normalizes it', () => {
      // GP returns some actions (e.g. GET_CHALLENGE_RESULT) without a trailing Z.
      const record = adaptGpActionObservation(action({ time_created: '2026-10-28T11:58:30.123' }) as never);
      expect(record.timeCreated).toBe('2026-10-28T11:58:30.123Z');
    });
  });

  describe('fetchRecentActionsPaginated', () => {
    const window = {
      fromTimeCreated: '2026-10-28T11:50:00.000Z',
      toTimeCreated: '2026-10-28T12:00:00.000Z',
      pageSize: 100,
      observerAppId: 'observer-app'
    };

    it('queries by day and re-applies the exact window client-side', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        okResponse([
          action({ id: 'in-window' }),
          action({ id: 'too-new', time_created: '2026-10-28T12:05:00.000Z' }),
          action({ id: 'too-old', time_created: '2026-10-28T11:00:00.000Z' })
        ])
      );

      const records = await fetchRecentActionsPaginated(deps(fetchImpl as unknown as typeof fetch), window);

      expect(records.map((r) => r.id)).toEqual(['in-window']);
      const url = new URL(String(fetchImpl.mock.calls[0]![0]));
      expect(url.pathname).toBe('/ucp/actions');
      expect(url.searchParams.get('from_time_created')).toBe('2026-10-28');
      expect(url.searchParams.get('order')).toBe('DESC');
    });

    it('keeps a zoneless in-window action regardless of the machine time zone', async () => {
      const originalTz = process.env.TZ;
      process.env.TZ = 'America/New_York';
      try {
        const fetchImpl = vi.fn().mockResolvedValue(
          okResponse([action({ id: 'zoneless', time_created: '2026-10-28T11:58:00.000' })])
        );

        const records = await fetchRecentActionsPaginated(deps(fetchImpl as unknown as typeof fetch), window);

        expect(records.map((r) => r.id)).toEqual(['zoneless']);
        expect(records[0]!.timeCreated).toBe('2026-10-28T11:58:00.000Z');
      } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
      }
    });

    it('reads the GP window format as UTC regardless of the machine time zone', async () => {
      const originalTz = process.env.TZ;
      process.env.TZ = 'America/New_York';
      try {
        const fetchImpl = vi.fn().mockResolvedValue(okResponse([action({ id: 'in-window' })]));

        const records = await fetchRecentActionsPaginated(deps(fetchImpl as unknown as typeof fetch), {
          ...window,
          fromTimeCreated: '2026-10-28 11:50:00',
          toTimeCreated: '2026-10-28 12:00:00'
        });

        expect(records.map((r) => r.id)).toEqual(['in-window']);
      } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
      }
    });

    it("excludes the observer's own polling actions but keeps the integrator's", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        okResponse([
          action({ id: 'own-list', type: 'TRANSACTION_LIST', app_id: 'observer-app' }),
          action({ id: 'own-token', type: 'CREATE_TOKEN', app_id: 'observer-app' }),
          action({ id: 'own-payer', type: 'PAYER_CREATE', app_id: 'observer-app' }),
          action({ id: 'their-list', type: 'TRANSACTION_LIST', app_id: 'integrator-app' })
        ])
      );

      const records = await fetchRecentActionsPaginated(deps(fetchImpl as unknown as typeof fetch), window);

      expect(records.map((r) => r.id)).toEqual(['own-payer', 'their-list']);
    });

    it('stops paging once a page reaches the start of the window', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          okResponse([action({ id: 'a' }), action({ id: 'old', time_created: '2026-10-28T10:00:00.000Z' })])
        )
        .mockResolvedValue(okResponse([action({ id: 'never-read' })]));

      const records = await fetchRecentActionsPaginated(deps(fetchImpl as unknown as typeof fetch), {
        ...window,
        pageSize: 2
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(records.map((r) => r.id)).toEqual(['a']);
    });

    it('throws instead of swallowing a rejected request', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => 'ACTION_NOT_AUTHORIZED'
      });

      await expect(
        fetchRecentActionsPaginated(deps(fetchImpl as unknown as typeof fetch), window)
      ).rejects.toBeInstanceOf(ActionsApiError);
    });

    it('classifies a 403 from /actions as an auth problem, not a bug', () => {
      const classified = toGlobalPaymentsError(new ActionsApiError('forbidden', 403, false));
      expect(classified.code).toBe(ERROR_CODES.E_AUTH_INVALID_CREDENTIALS);
    });
  });

  describe('matching and diagnosis', () => {
    it('matches on resource, and diagnosis treats resource as a blocking field', () => {
      const wrongResource = observedAction({ resource: 'ACCOUNTS' } as Partial<TransactionRecord>);
      expect(matchCaseToTransactions([wrongResource], payerCase).candidates).toHaveLength(0);

      const resourceCheck = buildMatcherChecks(payerCase).find((check) => check.field === 'resource');
      expect(resourceCheck?.blocking).toBe(true);
      expect(resourceCheck?.satisfied(resourceCheck.actual(wrongResource))).toBe(false);
    });

    it('tells the caller the case is observed through /actions', () => {
      const request = buildRequiredRequest(payerCase);
      expect(request.send).toEqual({ type: 'PAYER_CREATE', resource: 'PAYERS' });
      expect(request.notes.some((note) => note.includes('GET /actions'))).toBe(true);
    });

    it('accepts source in case YAML and defaults it to absent', () => {
      expect(caseSchema.parse({ ...payerCase }).source).toBe('actions');
      expect(caseSchema.parse({ ...saleCase }).source).toBeUndefined();
      expect(() => caseSchema.parse({ ...saleCase, source: 'webhooks' })).toThrow();
    });
  });

  describe('engine', () => {
    function client(overrides: Partial<Record<keyof GpApiClient, unknown>>): GpApiClient {
      return {
        fetchRecentTransactions: vi.fn().mockResolvedValue([]),
        fetchRecentActions: vi.fn().mockResolvedValue([]),
        fetchActions: vi.fn().mockResolvedValue([]),
        ...overrides
      } as unknown as GpApiClient;
    }

    it('polls only the feeds that active cases need', async () => {
      const api = client({});
      await new CertificationEngine(config, [pack([saleCase])], api, {}, {}).runOnce();
      expect(api.fetchRecentTransactions).toHaveBeenCalledTimes(1);
      expect(api.fetchRecentActions).not.toHaveBeenCalled();

      const actionsOnly = client({});
      await new CertificationEngine(config, [pack([payerCase])], actionsOnly, {}, {}).runOnce();
      expect(actionsOnly.fetchRecentActions).toHaveBeenCalledTimes(1);
      expect(actionsOnly.fetchRecentTransactions).not.toHaveBeenCalled();
    });

    it('judges an actions case against actions, never against transactions', async () => {
      const api = client({
        fetchRecentActions: vi.fn().mockResolvedValue([observedAction()])
      });

      const result = await new CertificationEngine(config, [pack([payerCase, saleCase])], api, {}, {}).runOnce();
      const byId = Object.fromEntries(result.cases.map((c) => [c.caseId, c]));

      expect(byId['payer-create']!.status).toBe('pass');
      expect(byId['sale']!.status).toBe('pending');
      expect(result.actionsFetched).toBe(1);
      expect(result.pollFailed).toBe(false);
    });

    it('fails an actions case whose request was rejected', async () => {
      const api = client({
        fetchRecentActions: vi
          .fn()
          .mockResolvedValue([observedAction({ responseCode: '400', status: 'ERROR' } as Partial<TransactionRecord>)])
      });

      const result = await new CertificationEngine(config, [pack([payerCase])], api, {}, {}).runOnce();
      expect(result.cases[0]!.status).toBe('fail');
      expect(result.cases[0]!.diagnosis?.code).toBe('EXPECTATION_VIOLATED');
    });

    it('scopes a failed feed to the cases that depend on it', async () => {
      const api = client({
        fetchRecentActions: vi.fn().mockRejectedValue(new ActionsApiError('forbidden', 403, false))
      });
      const engine = new CertificationEngine(config, [pack([payerCase, saleCase])], api, {}, {});
      const errors: Array<{ source: string }> = [];
      engine.on('pollError', (event: { source: string }) => errors.push(event));

      const result = await engine.runOnce();
      const byId = Object.fromEntries(result.cases.map((c) => [c.caseId, c]));

      expect(errors.map((e) => e.source)).toEqual(['actions']);
      expect(byId['payer-create']!.diagnosis?.code).toBe('OBSERVATION_FAILED');
      expect(byId['sale']!.diagnosis?.code).toBe('NO_TRANSACTIONS_OBSERVED');
      // Transactions were read, so the run is still judgeable.
      expect(result.pollFailed).toBe(false);
    });

    it('reports the window unread when the only needed feed fails', async () => {
      const api = client({
        fetchRecentActions: vi.fn().mockRejectedValue(new ActionsApiError('down', 503, true))
      });

      const result = await new CertificationEngine(config, [pack([payerCase])], api, {}, {}).runOnce();
      expect(result.pollFailed).toBe(true);
    });
  });
});
