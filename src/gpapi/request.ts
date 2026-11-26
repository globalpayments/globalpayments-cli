import type { AuthInput, AuthProvider } from './auth.js';
import { redactObject } from '../core/redaction.js';

export type GpApiMethod = 'GET' | 'POST';

export interface GpApiRequestDeps {
  authProvider: AuthProvider;
  authInput: AuthInput;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Abort the request after this long. Defaults to 30 seconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

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
  /**
   * @param status HTTP status, or 0 when no response arrived (unreachable host, timeout).
   * @param method Needed by callers to tell whether an unanswered request could still have
   *   changed state: a POST that timed out may have created a transaction.
   */
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly responseBody: unknown,
    readonly method: GpApiMethod = 'GET',
    options: { cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'GpApiRequestError';
    if (options.cause !== undefined) this.cause = options.cause;
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
  const fetchImpl = deps.fetchImpl ?? fetch;
  // One budget for the token and the request, so neither can hang on its own.
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
  const { accessToken } = await deps.authProvider.getToken(deps.authInput, { signal });

  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(endpoint, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-GP-Version': deps.authInput.apiVersion
      },
      signal,
      redirect: 'error',
      ...(request.method === 'POST' ? { body: JSON.stringify(request.body) } : {})
    });
    text = await response.text();
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    const reason = timeout.aborted ? 'timed out' : 'could not be completed';
    throw new GpApiRequestError(
      `GP API request ${request.method} ${request.path} ${reason}.`,
      0,
      request.path,
      undefined,
      request.method,
      { cause: error }
    );
  }

  const safeBody = safeResponseBody(parseResponseBody(text));

  if (!response.ok) {
    throw new GpApiRequestError(
      `GP API rejected ${request.method} ${request.path} (${response.status}).`,
      response.status,
      request.path,
      safeBody,
      request.method
    );
  }

  return { status: response.status, body: safeBody };
}
