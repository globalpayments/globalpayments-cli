import type { AuthInput, AuthProvider } from './auth.js';
import { redactObject } from '../core/redaction.js';

export type GpApiMethod = 'GET' | 'POST';

export interface GpApiRequestDeps {
  authProvider: AuthProvider;
  authInput: AuthInput;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface GpApiRequest {
  method: GpApiMethod;
  path: string;
  body?: unknown;
}

export interface GpApiResponse {
  status: number;
  body: unknown;
}

export class GpApiRequestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpApiRequestInputError';
  }
}

export class GpApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly responseBody: unknown
  ) {
    super(message);
    this.name = 'GpApiRequestError';
  }
}

function buildEndpoint(baseUrl: string, path: string): URL {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('#') ||
    /^[a-z][a-z\d+.-]*:/i.test(path)
  ) {
    throw new GpApiRequestInputError('API paths must be root-relative paths such as `/transactions`.');
  }

  const base = new URL(baseUrl);
  const endpoint = new URL(path.slice(1), `${base.toString().replace(/\/+$/, '')}/`);
  const basePath = base.pathname.replace(/\/+$/, '');

  if (endpoint.origin !== base.origin || !endpoint.pathname.startsWith(`${basePath}/`)) {
    throw new GpApiRequestInputError('API paths must stay within the configured GP API base path.');
  }

  return endpoint;
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return text;
    }
    throw error;
  }
}

function safeResponseBody(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map(safeResponseBody);
  }
  if (body && typeof body === 'object') {
    return redactObject(body as Record<string, unknown>);
  }
  return body;
}

export async function requestGpApi(
  deps: GpApiRequestDeps,
  request: GpApiRequest
): Promise<GpApiResponse> {
  const endpoint = buildEndpoint(deps.baseUrl, request.path);
  const { accessToken } = await deps.authProvider.getToken(deps.authInput);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(endpoint, {
    method: request.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-GP-Version': deps.authInput.apiVersion
    },
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(request.method === 'POST' ? { body: JSON.stringify(request.body) } : {})
  });

  const responseBody = parseResponseBody(await response.text());
  const safeBody = safeResponseBody(responseBody);

  if (!response.ok) {
    throw new GpApiRequestError(
      `GP API rejected ${request.method} ${request.path} (${response.status}).`,
      response.status,
      request.path,
      safeBody
    );
  }

  return { status: response.status, body: safeBody };
}
