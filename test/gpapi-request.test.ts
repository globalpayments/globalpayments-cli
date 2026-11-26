import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, toGlobalPaymentsError } from '../src/contract/errors.js';
import { NetworkAuthError, type AuthProvider } from '../src/gpapi/auth.js';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

  it('reports an unreachable GP API as a network error, not an internal bug', async () => {
    deps.fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed'));

    const error = await requestGpApi(deps, { method: 'GET', path: '/transactions' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GpApiRequestError);
    const gpError = toGlobalPaymentsError(error);
    expect(gpError.code).toBe(ERROR_CODES.E_NETWORK);
    expect(gpError.details).not.toHaveProperty('mayHaveBeenProcessed');
  });

  it('times out a request that never answers', async () => {
    deps.fetchImpl.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        })
    );

    const error = await requestGpApi({ ...deps, timeoutMs: 20 }, { method: 'GET', path: '/transactions' }).catch(
      (e: unknown) => e
    );

    expect((error as Error).message).toMatch(/timed out/);
    expect(toGlobalPaymentsError(error).code).toBe(ERROR_CODES.E_NETWORK);
  });

  it('warns that an unanswered POST may already have been processed', async () => {
    deps.fetchImpl.mockRejectedValueOnce(new TypeError('fetch failed'));

    const error = await requestGpApi(deps, { method: 'POST', path: '/transactions', body: {} }).catch((e: unknown) => e);

    const gpError = toGlobalPaymentsError(error);
    expect(gpError.code).toBe(ERROR_CODES.E_NETWORK);
    expect(gpError.details).toMatchObject({ mayHaveBeenProcessed: true });
    expect(gpError.remediation).toMatch(/before sending it again/);
  });

  it('treats rate limiting as transient and keeps the GP error body on auth failures', async () => {
    deps.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    const limited = await requestGpApi(deps, { method: 'POST', path: '/transactions', body: {} }).catch((e: unknown) => e);
    expect(toGlobalPaymentsError(limited).code).toBe(ERROR_CODES.E_NETWORK);
    expect(toGlobalPaymentsError(limited).details).not.toHaveProperty('mayHaveBeenProcessed');

    deps.fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ error_code: 'ACTION_NOT_AUTHORIZED', detailed_error_code: '40004' }), { status: 403 })
    );
    const forbidden = await requestGpApi(deps, { method: 'GET', path: '/disputes' }).catch((e: unknown) => e);
    expect(toGlobalPaymentsError(forbidden).code).toBe(ERROR_CODES.E_AUTH_INVALID_CREDENTIALS);
    expect(toGlobalPaymentsError(forbidden).details).toMatchObject({
      response: { error_code: 'ACTION_NOT_AUTHORIZED' }
    });
  });

  it('gives the token request the same deadline as the API request', async () => {
    const hangingAuth: AuthProvider = {
      getToken: (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new NetworkAuthError('GP API auth request timed out')));
        })
    };

    const error = await requestGpApi(
      { ...deps, authProvider: hangingAuth, timeoutMs: 20 },
      { method: 'GET', path: '/transactions' }
    ).catch((e: unknown) => e);

    expect(toGlobalPaymentsError(error).code).toBe(ERROR_CODES.E_NETWORK);
  });

  it('reports an unreadable --data-file as a usage error about that file', () => {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    for (const dataFile of ['does-not-exist.json', 'test']) {
      const result = spawnSync(
        process.execPath,
        ['--import', tsx, path.resolve('src', 'bin.ts'), 'api', 'post', '/transactions', '--data-file', dataFile, '--json'],
        { encoding: 'utf8', env: { ...process.env, GP_API_APP_ID: 'id', GP_API_APP_KEY: 'key', GP_API_ENVIRONMENT: 'sandbox' } }
      );
      const envelope = JSON.parse(result.stdout);
      expect(envelope.error.code).toBe(ERROR_CODES.E_USAGE);
      expect(envelope.error.message).toContain(dataFile);
    }
  }, 15_000);
});
