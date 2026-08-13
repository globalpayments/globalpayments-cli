import { createHash, randomUUID } from 'node:crypto';
import type { Environment } from '../types/domain.js';

export interface AuthInput {
  appId: string;
  appKey: string;
  nonce?: string;
  environment: Environment;
  apiVersion: string;
}

export interface AuthTokenMetadata {
  tokenType?: string;
  expiresIn?: number;
  expiresAt?: string;
  scope?: string;
}

export interface AuthProvider {
  getToken(input: AuthInput): Promise<{ accessToken: string; metadata: AuthTokenMetadata }>;
}

export interface AccessTokenResponse {
  token: string;
  type?: string;
  expiresIn?: number;
  expiresAt?: string;
  scope?: string;
}

interface CachedToken {
  accessToken: string;
  metadata: AuthTokenMetadata;
  expiresAtMs?: number;
}

interface ParsedErrorResponse {
  errorCode?: string;
  message?: string;
}

export class AuthFailureError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'AuthFailureError';
    this.status = status;
    this.code = code;
  }
}

export class InvalidCredentialsError extends AuthFailureError {
  constructor(message: string, status: number, code?: string) {
    super(message, status, code);
    this.name = 'InvalidCredentialsError';
  }
}

export class NetworkAuthError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NetworkAuthError';
    this.cause = cause;
  }
}

export class MalformedAuthResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedAuthResponseError';
  }
}

export function buildAuthSecret(appKey: string, nonce: string): string {
  // GP API spec: SHA512(nonce + appKey) — nonce MUST come first
  return createHash('sha512').update(`${nonce}${appKey}`).digest('hex');
}

export function createNonce(): string {
  return randomUUID();
}

export function computeSecretHash(appKey: string, nonce: string): string {
  return buildAuthSecret(appKey, nonce);
}

export function environmentBaseUrl(environment: Environment): string {
  return environment === 'sandbox'
    ? 'https://apis.sandbox.globalpay.com/ucp'
    : 'https://apis.globalpay.com/ucp';
}

const TOKEN_CACHE = new Map<string, CachedToken>();
const EXPIRY_SKEW_MS = 5_000;

function cacheKey(input: AuthInput): string {
  return [input.environment, input.appId, input.apiVersion].join('::');
}

function getCachedToken(input: AuthInput, nowMs: number): CachedToken | undefined {
  const entry = TOKEN_CACHE.get(cacheKey(input));
  if (!entry) {
    return undefined;
  }

  if (entry.expiresAtMs !== undefined && nowMs >= entry.expiresAtMs - EXPIRY_SKEW_MS) {
    TOKEN_CACHE.delete(cacheKey(input));
    return undefined;
  }

  if (entry.expiresAtMs === undefined) {
    TOKEN_CACHE.delete(cacheKey(input));
    return undefined;
  }

  return entry;
}

function putCachedToken(input: AuthInput, token: AccessTokenResponse): void {
  const expiresAtMs = token.expiresAt ? Date.parse(token.expiresAt) : undefined;
  if (expiresAtMs === undefined || Number.isNaN(expiresAtMs)) {
    return;
  }

  TOKEN_CACHE.set(cacheKey(input), {
    accessToken: token.token,
    metadata: {
      tokenType: token.type,
      expiresIn: token.expiresIn,
      expiresAt: token.expiresAt,
      scope: token.scope
    },
    expiresAtMs
  });
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MalformedAuthResponseError('GP API auth response is not a valid object');
  }

  return value as Record<string, unknown>;
}

function readOptionalString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function readOptionalNumber(input: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

export function parseAccessTokenResponse(payload: unknown, now = new Date()): AccessTokenResponse {
  const body = asObject(payload);

  // TODO(gpapi-auth): Confirm exact field set from all GP environments; adapter is tolerant to snake_case/camelCase variants.
  const token = readOptionalString(body, ['token', 'access_token']);
  if (!token) {
    throw new MalformedAuthResponseError('GP API auth response does not include a token');
  }

  const type = readOptionalString(body, ['type', 'token_type']);
  const scope = readOptionalString(body, ['scope']);
  const expiresIn = readOptionalNumber(body, ['expires_in', 'expiresIn', 'seconds_to_expire']);
  const explicitExpiry = readOptionalString(body, ['expiry', 'expires_at', 'expiresAt']);

  let expiresAt: string | undefined;
  if (explicitExpiry) {
    const parsed = Date.parse(explicitExpiry);
    if (Number.isNaN(parsed)) {
      throw new MalformedAuthResponseError('GP API auth response has an invalid expiry timestamp');
    }
    expiresAt = new Date(parsed).toISOString();
  } else if (expiresIn !== undefined) {
    expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();
  }

  return {
    token,
    type,
    expiresIn,
    expiresAt,
    scope
  };
}

function buildSafeFailureMessage(status: number, parsed: ParsedErrorResponse | undefined): string {
  if (parsed?.message) {
    return `GP API auth request failed (${status}): ${parsed.message}`;
  }
  return `GP API auth request failed (${status})`;
}

async function parseErrorResponse(response: Response): Promise<ParsedErrorResponse | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return undefined;
  }

  try {
    const json = asObject(await response.json());
    return {
      errorCode: readOptionalString(json, ['error_code', 'code', 'error']),
      message: readOptionalString(json, ['error_description', 'message'])
    };
  } catch {
    return undefined;
  }
}

export function toSafeTokenMetadata(tokenResponse: AccessTokenResponse): Record<string, unknown> {
  return {
    tokenReceived: tokenResponse.token.length > 0,
    tokenType: tokenResponse.type,
    expiresIn: tokenResponse.expiresIn,
    expiresAt: tokenResponse.expiresAt,
    scope: tokenResponse.scope
  };
}

export class GpApiAuthProvider implements AuthProvider {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly nonceFactory: () => string = createNonce,
    private readonly nowFactory: () => Date = () => new Date()
  ) {}

  async getToken(input: AuthInput): Promise<{ accessToken: string; metadata: AuthTokenMetadata }> {
    const now = this.nowFactory();
    const nowMs = now.getTime();
    const cached = getCachedToken(input, nowMs);
    if (cached) {
      return {
        accessToken: cached.accessToken,
        metadata: cached.metadata
      };
    }

    const nonce = input.nonce ?? this.nonceFactory();
    const secret = buildAuthSecret(input.appKey, nonce);

    let response: Response;
    try {
      response = await this.fetchImpl(`${environmentBaseUrl(input.environment)}/accesstoken`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GP-Version': input.apiVersion
        },
        body: JSON.stringify({
          app_id: input.appId,
          nonce,
          secret,
          grant_type: 'client_credentials'
        })
      });
    } catch (error: unknown) {
      throw new NetworkAuthError('Unable to reach GP API auth endpoint', error);
    }

    if (!response.ok) {
      const parsed = await parseErrorResponse(response);
      const message = buildSafeFailureMessage(response.status, parsed);
      if (response.status === 401 || response.status === 403) {
        throw new InvalidCredentialsError(message, response.status, parsed?.errorCode);
      }
      throw new AuthFailureError(message, response.status, parsed?.errorCode);
    }

    const payload = await response.json();
    const tokenResponse = parseAccessTokenResponse(payload, now);
    putCachedToken(input, tokenResponse);

    return {
      accessToken: tokenResponse.token,
      metadata: {
        tokenType: tokenResponse.type,
        expiresIn: tokenResponse.expiresIn,
        expiresAt: tokenResponse.expiresAt,
        scope: tokenResponse.scope
      }
    };
  }
}
