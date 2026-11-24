import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, toGlobalPaymentsError } from '../src/contract/errors.js';
import type { AuthProvider } from '../src/gpapi/auth.js';
import { GpApiRequestError, requestGpApi } from '../src/gpapi/request.js';

const authProvider: AuthProvider = {
  getToken: vi.fn().mockResolvedValue({
    accessToken: 'access-token',
    metadata: { tokenType: 'bearer' }
  })
};

const deps = {
  authProvider,
  authInput: {
    appId: 'app-id',
    appKey: 'app-key',
    environment: 'sandbox' as const,
    apiVersion: '2021-03-22'
  },
  baseUrl: 'https://apis.sandbox.globalpay.com/ucp',
  fetchImpl: vi.fn<typeof fetch>()
};

describe('authenticated GP API requests', () => {
  it('sends authenticated requests only to the configured UCP base path', async () => {
    deps.fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ transactions: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    await requestGpApi(deps, { method: 'GET', path: '/transactions?status=DECLINED' });

    const [url, init] = deps.fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://apis.sandbox.globalpay.com/ucp/transactions?status=DECLINED');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer access-token');
    expect((init?.headers as Record<string, string>)['X-GP-Version']).toBe('2021-03-22');
  });

  it.each(['https://attacker.example/transactions', '//attacker.example/transactions', '/../outside'])(
    'rejects a path that could escape the GP API boundary: %s',
    async (path) => {
      await expect(requestGpApi(deps, { method: 'GET', path })).rejects.toThrow(
        'API paths must'
      );
    }
  );

  it('redacts sensitive values recursively from successful API responses', async () => {
    deps.fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: 'secret-token',
          payment_method: { card_number: '4111111111111111' },
          nested: [{ authorization: 'Bearer secret' }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await requestGpApi(deps, { method: 'GET', path: '/transactions/TRN_1' });
    expect(result.body).toEqual({
      token: '[REDACTED]',
      payment_method: { card_number: '[REDACTED]' },
      nested: [{ authorization: '[REDACTED]' }]
    });
  });

  it('classifies a GP 4xx rejection separately and redacts its response body', async () => {
    deps.fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ error_code: 'INVALID', app_key: 'secret' }), {
        status: 422,
        headers: { 'content-type': 'application/json' }
      })
    );

    const error = await requestGpApi(deps, { method: 'POST', path: '/transactions', body: {} }).catch(
      (value: unknown) => value
    );

    expect(error).toBeInstanceOf(GpApiRequestError);
    expect(toGlobalPaymentsError(error).code).toBe(ERROR_CODES.E_API_REJECTED);
    expect(toGlobalPaymentsError(error).details?.response).toEqual({
      error_code: 'INVALID',
      app_key: '[REDACTED]'
    });
  });
});
