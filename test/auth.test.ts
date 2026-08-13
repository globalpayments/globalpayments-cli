import { describe, expect, it, vi } from 'vitest';
import {
  AuthFailureError,
  GpApiAuthProvider,
  InvalidCredentialsError,
  MalformedAuthResponseError,
  NetworkAuthError,
  buildAuthSecret,
  computeSecretHash,
  createNonce,
  environmentBaseUrl,
  parseAccessTokenResponse,
  toSafeTokenMetadata,
  type AuthInput
} from '../src/gpapi/auth.js';

function buildInput(overrides: Partial<AuthInput> = {}): AuthInput {
  return {
    appId: 'app-id',
    appKey: 'app-key',
    environment: 'sandbox',
    apiVersion: '2021-03-22',
    ...overrides
  };
}

describe('gpapi auth', () => {
  it('builds deterministic SHA-512 secret hashes', () => {
    const hash = buildAuthSecret('my-key', 'nonce-1');
    expect(hash).toHaveLength(128);
    expect(hash).toBe(computeSecretHash('my-key', 'nonce-1'));
  });

  it('hashes with nonce first per GP API spec (SHA512(nonce + appKey))', () => {
    // Pre-computed: SHA512("nonce-1" + "my-key") — nonce must precede appKey
    const expected =
      '91c1f50067957021387d2b331aa4f6b10b8808e22b5ed622586d2ac9e6847dbc4290ca9799b983dd7610699a29601fe710a293c147d33d5a45d4ce34a7c55dc4';
    expect(buildAuthSecret('my-key', 'nonce-1')).toBe(expected);
  });

  it('creates a UUID nonce', () => {
    const nonce = createNonce();
    expect(nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('resolves auth base URL by environment', () => {
    expect(environmentBaseUrl('sandbox')).toBe('https://apis.sandbox.globalpay.com/ucp');
    expect(environmentBaseUrl('production')).toBe('https://apis.globalpay.com/ucp');
  });

  it('requests access token and caches until expiry', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 'tok_123',
          type: 'bearer',
          expires_in: 60,
          scope: 'transactions:read'
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
    );

    const provider = new GpApiAuthProvider(fetchMock, () => 'nonce-abc', () => new Date('2026-01-01T00:00:00.000Z'));
    const input = buildInput({ appId: 'app-id-cache' });

    const first = await provider.getToken(input);
    const second = await provider.getToken(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.accessToken).toBe('tok_123');
    expect(second.accessToken).toBe('tok_123');
    expect(first.metadata.tokenType).toBe('bearer');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://apis.sandbox.globalpay.com/ucp/accesstoken');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'Content-Type': 'application/json',
      'X-GP-Version': '2021-03-22'
    });

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.app_id).toBe('app-id-cache');
    expect(body.nonce).toBe('nonce-abc');
    expect(body.grant_type).toBe('client_credentials');
    expect(typeof body.secret).toBe('string');
    expect(String(body.secret)).toHaveLength(128);
  });

  it('refreshes token after cache expiry', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'tok_first', type: 'bearer', expires_in: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'tok_second', type: 'bearer', expires_in: 60 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );

    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const provider = new GpApiAuthProvider(fetchMock, () => 'nonce-exp', () => new Date(nowMs));
    const input = buildInput({ appId: 'app-id-expiry' });

    const first = await provider.getToken(input);
    nowMs += 2_000;
    const second = await provider.getToken(input);

    expect(first.accessToken).toBe('tok_first');
    expect(second.accessToken).toBe('tok_second');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws invalid credentials for 401/403 responses', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error_code: 'AUTH_01', message: 'invalid credentials' }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })
    );

    const provider = new GpApiAuthProvider(fetchMock);

    await expect(provider.getToken(buildInput({ appId: 'app-id-401' }))).rejects.toBeInstanceOf(
      InvalidCredentialsError
    );
  });

  it('throws auth failure for non-credential HTTP failures', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'upstream unavailable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' }
      })
    );

    const provider = new GpApiAuthProvider(fetchMock);

    await expect(provider.getToken(buildInput({ appId: 'app-id-502' }))).rejects.toBeInstanceOf(
      AuthFailureError
    );
  });

  it('throws network error when fetch rejects', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    const provider = new GpApiAuthProvider(fetchMock);

    await expect(provider.getToken(buildInput({ appId: 'app-id-network' }))).rejects.toBeInstanceOf(
      NetworkAuthError
    );
  });

  it('throws malformed response error when token payload is invalid', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ type: 'bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const provider = new GpApiAuthProvider(fetchMock);

    await expect(provider.getToken(buildInput({ appId: 'app-id-malformed' }))).rejects.toBeInstanceOf(
      MalformedAuthResponseError
    );
  });

  it('parses token response metadata and builds safe log payload', () => {
    const parsed = parseAccessTokenResponse(
      {
        access_token: 'tok_abc',
        token_type: 'bearer',
        expires_in: '60',
        scope: 'transactions:read'
      },
      new Date('2026-01-01T00:00:00.000Z')
    );

    expect(parsed.token).toBe('tok_abc');
    expect(parsed.type).toBe('bearer');
    expect(parsed.expiresIn).toBe(60);
    expect(parsed.expiresAt).toBe('2026-01-01T00:01:00.000Z');

    const safe = toSafeTokenMetadata(parsed);
    expect(safe.tokenReceived).toBe(true);
    expect((safe as Record<string, unknown>).token).toBeUndefined();
  });

  it('rejects invalid expiry timestamps in token response', () => {
    expect(() => parseAccessTokenResponse({ token: 'abc', expiry: 'not-a-date' })).toThrow(
      MalformedAuthResponseError
    );
  });
});
