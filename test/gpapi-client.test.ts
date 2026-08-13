import { describe, expect, it, vi } from 'vitest';
import type { AuthProvider } from '../src/gpapi/auth.js';
import { HttpGpApiClient } from '../src/gpapi/client.js';

describe('gpapi client', () => {
  it('uses auth token and transaction transport for poll window', async () => {
    const authProvider: AuthProvider = {
      getToken: vi.fn().mockResolvedValue({
        accessToken: 'tok_client',
        metadata: { tokenType: 'bearer' }
      })
    };

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ transactions: [], page: 1, total_pages: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const client = new HttpGpApiClient({
      authProvider,
      authInput: {
        appId: 'app-id',
        appKey: 'app-key',
        environment: 'sandbox',
        apiVersion: '2021-03-22'
      },
      accountName: 'merchant-account',
      fetchImpl: fetchMock,
      maxPagesPerPoll: 1,
      maxRecordsPerPoll: 10
    });

    await client.fetchRecentTransactions({
      fromTimeCreated: '2026-01-01T00:00:00Z',
      toTimeCreated: '2026-01-01T00:05:00Z',
      page: 1,
      pageSize: 10,
      order: 'DESC'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain('/transactions?');
    expect(String(url)).toContain('account_name=merchant-account');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok_client');
  });
});
