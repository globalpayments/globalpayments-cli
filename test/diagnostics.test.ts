import { describe, it, expect, vi } from 'vitest';
import { adaptGpAction, buildActionsQueryParams, fetchActionsPage } from '../src/gpapi/actions.js';
import { enrichCaseWithDiagnostics, enrichCasesWithDiagnostics } from '../src/core/diagnostics.js';
import type { ActionRecord, GpActionApiShape } from '../src/gpapi/actions.js';
import type { CaseEvaluationResult } from '../src/types/domain.js';

describe('actions API', () => {
  describe('adaptGpAction', () => {
    it('should adapt a minimal action', () => {
      const apiAction: GpActionApiShape = { id: 'act123' };
      const result = adaptGpAction(apiAction);
      expect(result.id).toBe('act123');
      expect(result.type).toBeUndefined();
      expect(result.responseCode).toBeUndefined();
    });

    it('should adapt an action with type and response code', () => {
      const apiAction: GpActionApiShape = {
        id: 'act123',
        action_type: 'CREATE_TRANSACTION',
        response_code: '00'
      };
      const result = adaptGpAction(apiAction);
      expect(result.id).toBe('act123');
      expect(result.type).toBe('CREATE_TRANSACTION');
      expect(result.responseCode).toBe('00');
    });

    it('should use http_response_code as fallback for response code', () => {
      const apiAction: GpActionApiShape = {
        id: 'act123',
        http_response_code: 200
      };
      const result = adaptGpAction(apiAction);
      expect(result.responseCode).toBe(200);
    });

    it('should prioritize action_type over type field', () => {
      const apiAction: GpActionApiShape = {
        id: 'act123',
        action_type: 'ACTION_TYPE',
        type: 'LEGACY_TYPE'
      };
      const result = adaptGpAction(apiAction);
      expect(result.type).toBe('ACTION_TYPE');
    });

    it('should handle missing id with fallback', () => {
      const apiAction: GpActionApiShape = {};
      const result = adaptGpAction(apiAction);
      expect(result.id).toBe('unknown-id');
    });
  });

  describe('buildActionsQueryParams', () => {
    it('should build params with required fields only', () => {
      const query = { page_size: 10 };
      const params = buildActionsQueryParams(query);
      expect(params.get('page_size')).toBe('10');
      expect(params.get('page')).toBeNull();
    });

    it('should include all optional fields when provided', () => {
      const query = {
        page: 2,
        page_size: 20,
        order: 'desc',
        order_by: 'time_created',
        resource: 'TRANSACTIONS',
        resource_id: 'txn123',
        resource_status: 'SUCCESS',
        from_time_created: '2024-01-01T00:00:00Z',
        to_time_created: '2024-01-02T00:00:00Z',
        response_code: '00',
        account_name: 'test-account'
      };
      const params = buildActionsQueryParams(query);
      expect(params.get('page')).toBe('2');
      expect(params.get('page_size')).toBe('20');
      expect(params.get('order')).toBe('desc');
      expect(params.get('order_by')).toBe('time_created');
      expect(params.get('resource')).toBe('TRANSACTIONS');
      expect(params.get('resource_id')).toBe('txn123');
      expect(params.get('resource_status')).toBe('SUCCESS');
      expect(params.get('response_code')).toBe('00');
      expect(params.get('account_name')).toBe('test-account');
    });

    it('should omit optional fields when not provided', () => {
      const query = { page_size: 10 };
      const params = buildActionsQueryParams(query);
      expect(params.has('page')).toBe(false);
      expect(params.has('order')).toBe(false);
    });
  });

  describe('fetchActionsPage', () => {
    it('should handle a successful response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          actions: [
            { id: 'act1', action_type: 'CREATE', response_code: '00' },
            { id: 'act2', action_type: 'CAPTURE', response_code: '00' }
          ]
        })
      });

      const result = await fetchActionsPage(
        {
          authProvider: { getToken: async () => ({ accessToken: 'token', metadata: {} }) },
          authInput: { appId: 'app', appKey: 'key', environment: 'sandbox', apiVersion: 'v1' },
          baseUrl: 'https://api.example.com',
          apiVersion: 'v1',
          fetchImpl: mockFetch
        },
        { page_size: 10, resource: 'TRANSACTIONS', resource_id: 'txn123' }
      );

      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe('act1');
      expect(result[0]!.type).toBe('CREATE');
      expect(result[1]!.responseCode).toBe('00');
    });

    it('should gracefully handle fetch errors', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await fetchActionsPage(
        {
          authProvider: { getToken: async () => ({ accessToken: 'token', metadata: {} }) },
          authInput: { appId: 'app', appKey: 'key', environment: 'sandbox', apiVersion: 'v1' },
          baseUrl: 'https://api.example.com',
          apiVersion: 'v1',
          fetchImpl: mockFetch
        },
        { page_size: 10 }
      );

      expect(result).toEqual([]);
    });

    it('should gracefully handle non-ok responses', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error'
      });

      const result = await fetchActionsPage(
        {
          authProvider: { getToken: async () => ({ accessToken: 'token', metadata: {} }) },
          authInput: { appId: 'app', appKey: 'key', environment: 'sandbox', apiVersion: 'v1' },
          baseUrl: 'https://api.example.com',
          apiVersion: 'v1',
          fetchImpl: mockFetch
        },
        { page_size: 10 }
      );

      expect(result).toEqual([]);
    });
  });
});

describe('diagnostics enrichment', () => {
  describe('enrichCaseWithDiagnostics', () => {
    const mockAuthProvider = {
      getToken: vi.fn().mockResolvedValue({ accessToken: 'token', metadata: {} })
    };

    const mockDeps = {
      authProvider: mockAuthProvider,
      authInput: { appId: 'app', appKey: 'key', environment: 'sandbox' as const, apiVersion: 'v1' },
      baseUrl: 'https://api.example.com',
      apiVersion: 'v1',
      fetchImpl: vi.fn()
    };

    it('should not enrich passing cases', async () => {
      const caseResult: CaseEvaluationResult = {
        namespacedCaseId: 'pack:case1',
        packId: 'pack',
        caseId: 'case1',
        status: 'pass',
        reason: 'matched',
        latestMatch: { id: 'txn1', timeCreated: '2024-01-01T00:00:00Z' },
        matchedCount: 1
      };

      const result = await enrichCaseWithDiagnostics(caseResult, mockDeps);
      expect(result).toEqual(caseResult);
      expect(mockAuthProvider.getToken).not.toHaveBeenCalled();
    });

    it('should not enrich pending cases', async () => {
      const caseResult: CaseEvaluationResult = {
        namespacedCaseId: 'pack:case1',
        packId: 'pack',
        caseId: 'case1',
        status: 'pending',
        reason: 'no match',
        matchedCount: 0
      };

      const result = await enrichCaseWithDiagnostics(caseResult, mockDeps);
      expect(result).toEqual(caseResult);
    });

    it('should not enrich failed cases without latestMatch', async () => {
      const caseResult: CaseEvaluationResult = {
        namespacedCaseId: 'pack:case1',
        packId: 'pack',
        caseId: 'case1',
        status: 'fail',
        reason: 'evaluator failed',
        matchedCount: 0
      };

      const result = await enrichCaseWithDiagnostics(caseResult, mockDeps);
      expect(result).toEqual(caseResult);
    });

    it('should enrich failed cases with diagnostics', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          actions: [
            { id: 'act1', action_type: 'CHECK_FRAUD', response_code: '05' },
            { id: 'act2', action_type: 'AUTHORIZE', response_code: '00' }
          ]
        })
      });

      const caseResult: CaseEvaluationResult = {
        namespacedCaseId: 'pack:case1',
        packId: 'pack',
        caseId: 'case1',
        status: 'fail',
        reason: 'evaluator failed',
        latestMatch: { id: 'txn1', timeCreated: '2024-01-01T00:00:00Z' },
        matchedCount: 1
      };

      const enrichedDeps = { ...mockDeps, fetchImpl: mockFetch };
      const result = await enrichCaseWithDiagnostics(caseResult, enrichedDeps);

      expect(result.evidence?.diagnostics).toBeDefined();
      expect(result.evidence?.diagnostics?.length).toBe(2);
      if (result.evidence?.diagnostics) {
        expect(result.evidence.diagnostics[0]!.id).toBe('act1');
        expect(result.evidence.diagnostics[0]!.type).toBe('CHECK_FRAUD');
      }
    });

    it('should return original case if actions fetch returns empty', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ actions: [] })
      });

      const caseResult: CaseEvaluationResult = {
        namespacedCaseId: 'pack:case1',
        packId: 'pack',
        caseId: 'case1',
        status: 'fail',
        reason: 'evaluator failed',
        latestMatch: { id: 'txn1', timeCreated: '2024-01-01T00:00:00Z' },
        matchedCount: 1
      };

      const enrichedDeps = { ...mockDeps, fetchImpl: mockFetch };
      const result = await enrichCaseWithDiagnostics(caseResult, enrichedDeps);

      expect(result).toEqual(caseResult);
    });
  });

  describe('enrichCasesWithDiagnostics', () => {
    const mockAuthProvider = {
      getToken: vi.fn().mockResolvedValue({ accessToken: 'token', metadata: {} })
    };

    const mockDeps = {
      authProvider: mockAuthProvider,
      authInput: { appId: 'app', appKey: 'key', environment: 'sandbox' as const, apiVersion: 'v1' },
      baseUrl: 'https://api.example.com',
      apiVersion: 'v1',
      fetchImpl: vi.fn()
    };

    it('should enrich multiple failed cases', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          actions: [{ id: 'act1', action_type: 'AUDIT', response_code: '00' }]
        })
      });

      const cases: CaseEvaluationResult[] = [
        {
          namespacedCaseId: 'pack:case1',
          packId: 'pack',
          caseId: 'case1',
          status: 'pass',
          reason: 'matched',
          latestMatch: { id: 'txn1', timeCreated: '2024-01-01T00:00:00Z' },
          matchedCount: 1
        },
        {
          namespacedCaseId: 'pack:case2',
          packId: 'pack',
          caseId: 'case2',
          status: 'fail',
          reason: 'evaluator failed',
          latestMatch: { id: 'txn2', timeCreated: '2024-01-01T01:00:00Z' },
          matchedCount: 1
        },
        {
          namespacedCaseId: 'pack:case3',
          packId: 'pack',
          caseId: 'case3',
          status: 'fail',
          reason: 'evaluator failed',
          latestMatch: { id: 'txn3', timeCreated: '2024-01-01T02:00:00Z' },
          matchedCount: 1
        }
      ];

      const enrichedDeps = { ...mockDeps, fetchImpl: mockFetch };
      const result = await enrichCasesWithDiagnostics(cases, enrichedDeps);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual(cases[0]); // Pass case unchanged

      // Fail case enriched
      expect(result[1]!.evidence?.diagnostics).toBeDefined();
      if (result[1]!.evidence?.diagnostics) {
        expect(result[1]!.evidence.diagnostics.length).toBeGreaterThan(0);
      }

      // Fail case enriched
      expect(result[2]!.evidence?.diagnostics).toBeDefined();
      if (result[2]!.evidence?.diagnostics) {
        expect(result[2]!.evidence.diagnostics.length).toBeGreaterThan(0);
      }
    });

    it('should return original cases if no failed cases', async () => {
      const cases: CaseEvaluationResult[] = [
        {
          namespacedCaseId: 'pack:case1',
          packId: 'pack',
          caseId: 'case1',
          status: 'pass',
          reason: 'matched',
          latestMatch: { id: 'txn1', timeCreated: '2024-01-01T00:00:00Z' },
          matchedCount: 1
        }
      ];

      const result = await enrichCasesWithDiagnostics(cases, mockDeps);
      expect(result).toEqual(cases);
    });
  });
});
