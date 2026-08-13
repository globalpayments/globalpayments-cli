import { describe, expect, it, vi } from 'vitest';
import type { AuthProvider } from '../src/gpapi/auth.js';
import {
  buildTransactionsQueryParams,
  fetchRecentTransactionsPaginated,
  fetchTransactionsPage,
  type TransactionsApiDeps
} from '../src/gpapi/transactions.js';

function buildDeps(fetchImpl: typeof fetch): TransactionsApiDeps {
  const authProvider: AuthProvider = {
    getToken: vi.fn().mockResolvedValue({
      accessToken: 'tok_test',
      metadata: { tokenType: 'bearer' }
    })
  };

  return {
    authProvider,
    authInput: {
      appId: 'app-id',
      appKey: 'app-key',
      environment: 'sandbox',
      apiVersion: '2021-03-22'
    },
    baseUrl: 'https://apis.sandbox.globalpay.com/ucp',
    apiVersion: '2021-03-22',
    fetchImpl,
    retryPolicy: {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0
    }
  };
}

describe('gpapi transactions', () => {
  it('builds expected transactions query parameters', () => {
    const params = buildTransactionsQueryParams({
      fromTimeCreated: '2026-01-01T00:00:00Z',
      toTimeCreated: '2026-01-01T00:30:00Z',
      page: 2,
      pageSize: 50,
      order: 'DESC',
      orderBy: 'time_created',
      accountName: 'ACC-1'
    });

    expect(params.get('from_time_created')).toBe('2026-01-01T00:00:00Z');
    expect(params.get('to_time_created')).toBe('2026-01-01T00:30:00Z');
    expect(params.get('page')).toBe('2');
    expect(params.get('page_size')).toBe('50');
    expect(params.get('order')).toBe('DESC');
    expect(params.get('order_by')).toBe('time_created');
    expect(params.get('account_name')).toBe('ACC-1');
  });

  it('fetches and normalizes transactions with account filter', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [
            {
              id: 'txn-1',
              time_created: '2026-01-01T00:00:10Z',
              account_name: 'ACC-1',
              reference: 'ref-1',
              type: 'SALE',
              channel: 'CNP',
              status: 'CAPTURED',
              amount: 120,
              currency: 'USD',
              response_code: '00',
              response_message: 'approved',
              payment_method: {
                entry_mode: 'ECOM',
                card: {
                  brand: 'VISA',
                  masked_number_last4: '1111',
                  authcode: 'A1'
                }
              }
            },
            {
              id: 'txn-2',
              time_created: '2026-01-01T00:00:11Z',
              account_name: 'OTHER',
              reference: 'ref-2'
            }
          ],
          page: 1,
          total_pages: 1
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
    );

    const result = await fetchTransactionsPage(buildDeps(fetchMock), {
      fromTimeCreated: '2026-01-01T00:00:00Z',
      toTimeCreated: '2026-01-01T00:30:00Z',
      page: 1,
      pageSize: 20,
      order: 'DESC',
      accountName: 'acc-1'
    });

    expect(result.hasMore).toBe(false);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.id).toBe('txn-1');
    expect(result.records[0]?.paymentMethod?.entryMode).toBe('ECOM');
    expect(result.records[0]?.paymentMethod?.cardBrand).toBe('VISA');
    expect(result.records[0]?.paymentMethod?.last4).toBe('1111');
    expect(result.records[0]?.paymentMethod?.authCode).toBe('A1');
    expect(result.records[0]?.raw).toBeTruthy();
  });

  it('retries transient errors with backoff policy', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('service unavailable', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transactions: [], page: 1, total_pages: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );

    const result = await fetchTransactionsPage(buildDeps(fetchMock), {
      fromTimeCreated: '2026-01-01T00:00:00Z',
      toTimeCreated: '2026-01-01T00:30:00Z',
      page: 1,
      pageSize: 20,
      order: 'DESC'
    });

    expect(result.records).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('iterates pages until max records are collected', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transactions: [{ id: 'txn-1', time_created: '2026-01-01T00:00:01Z' }],
            page: 1,
            total_pages: 2
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transactions: [{ id: 'txn-2', time_created: '2026-01-01T00:00:02Z' }],
            page: 2,
            total_pages: 2
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      );

    const records = await fetchRecentTransactionsPaginated(
      buildDeps(fetchMock),
      {
        fromTimeCreated: '2026-01-01T00:00:00Z',
        toTimeCreated: '2026-01-01T00:30:00Z',
        page: 1,
        pageSize: 1,
        order: 'DESC'
      },
      {
        maxPages: 3,
        maxRecords: 2
      }
    );

    expect(records.map((record) => record.id)).toEqual(['txn-1', 'txn-2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
