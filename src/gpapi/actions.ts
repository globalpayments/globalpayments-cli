import type { AuthInput, AuthProvider } from './auth.js';

export interface ActionRecord {
  id: string;
  type?: string;
  responseCode?: string | number;
}

export interface GpActionApiShape {
  id?: string;
  action_type?: string;
  type?: string;
  response_code?: string | number;
  http_response_code?: string | number;
  resource?: string;
  resource_id?: string;
  resource_status?: string;
  time_created?: string;
  timeCreated?: string;
  account_name?: string;
  accountName?: string;
}

export interface ActionsQuery {
  page?: number;
  page_size: number;
  order?: string;
  order_by?: string;
  resource?: string;
  resource_id?: string;
  resource_status?: string;
  from_time_created?: string;
  to_time_created?: string;
  response_code?: string | number;
  account_name?: string;
}

export interface ActionsApiDeps {
  authProvider: AuthProvider;
  authInput: AuthInput;
  baseUrl: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
}

export class ActionsApiError extends Error {
  readonly status: number;
  readonly retriable: boolean;

  constructor(message: string, status: number, retriable: boolean) {
    super(message);
    this.name = 'ActionsApiError';
    this.status = status;
    this.retriable = retriable;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function asString(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim().length > 0 ? input : undefined;
}

function asNumber(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === 'string' && input.trim().length > 0) {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asActionArray(input: unknown): GpActionApiShape[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((item): item is GpActionApiShape => isObject(item));
}

function readActionArray(payload: unknown): GpActionApiShape[] {
  if (Array.isArray(payload)) {
    return asActionArray(payload);
  }

  if (!isObject(payload)) {
    return [];
  }

  const topLevel =
    asActionArray(payload.actions) ||
    asActionArray(payload.items) ||
    asActionArray(payload.data);
  if (topLevel.length > 0) {
    return topLevel;
  }

  if (isObject(payload.data)) {
    const nested =
      asActionArray(payload.data.actions) ||
      asActionArray(payload.data.items) ||
      asActionArray(payload.data.results);
    if (nested.length > 0) {
      return nested;
    }
  }

  return [];
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function adaptGpAction(apiAction: GpActionApiShape): ActionRecord {
  const responseCode = apiAction.response_code ?? apiAction.http_response_code;
  return {
    id: apiAction.id ?? 'unknown-id',
    type: apiAction.action_type ?? apiAction.type,
    responseCode
  };
}

export function buildActionsQueryParams(query: ActionsQuery): URLSearchParams {
  const params = new URLSearchParams();

  if (query.page !== undefined) {
    params.set('page', String(query.page));
  }
  if (query.page_size !== undefined) {
    params.set('page_size', String(query.page_size));
  }
  if (query.order) {
    params.set('order', query.order);
  }
  if (query.order_by) {
    params.set('order_by', query.order_by);
  }
  if (query.resource) {
    params.set('resource', query.resource);
  }
  if (query.resource_id) {
    params.set('resource_id', query.resource_id);
  }
  if (query.resource_status) {
    params.set('resource_status', query.resource_status);
  }
  if (query.from_time_created) {
    params.set('from_time_created', query.from_time_created);
  }
  if (query.to_time_created) {
    params.set('to_time_created', query.to_time_created);
  }
  if (query.response_code !== undefined) {
    params.set('response_code', String(query.response_code));
  }
  if (query.account_name) {
    params.set('account_name', query.account_name);
  }

  return params;
}

export async function fetchActionsPage(
  deps: ActionsApiDeps,
  query: ActionsQuery
): Promise<ActionRecord[]> {
  try {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const { accessToken } = await deps.authProvider.getToken(deps.authInput);
    const endpoint = `${normalizeBaseUrl(deps.baseUrl)}/actions?${buildActionsQueryParams(query).toString()}`;

    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-GP-Version': deps.apiVersion
      }
    });

    if (!response.ok) {
      let details = '';
      try {
        details = await response.text();
      } catch {
        details = '';
      }

      throw new ActionsApiError(
        `GP API actions request failed (${response.status})${details ? `: ${details}` : ''}`,
        response.status,
        isTransientStatus(response.status)
      );
    }

    const payload = await response.json();
    const actions = readActionArray(payload).map((action) => adaptGpAction(action));

    return actions;
  } catch (error: unknown) {
    // Best-effort diagnostics: if actions fetch fails, return empty array
    // Do not fail the certification run
    if (error instanceof ActionsApiError) {
      return [];
    }
    return [];
  }
}
