import type { PollOrder, TransactionRecord } from '../types/domain.js';
import { adaptGpTransaction, type GpTransactionApiShape } from './adapters.js';
import type { AuthInput, AuthProvider } from './auth.js';

export interface TransactionsQuery {
  fromTimeCreated: string;
  toTimeCreated: string;
  page?: number;
  pageSize: number;
  order: PollOrder;
  orderBy?: string;
  accountName?: string;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface TransactionsApiDeps {
  authProvider: AuthProvider;
  authInput: AuthInput;
  baseUrl: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
  retryPolicy?: Partial<RetryPolicy>;
}

export interface PaginatedFetchOptions {
  maxRecords?: number;
  maxPages?: number;
}

export class TransactionsApiError extends Error {
  readonly status: number;
  readonly retriable: boolean;

  constructor(message: string, status: number, retriable: boolean) {
    super(message);
    this.name = 'TransactionsApiError';
    this.status = status;
    this.retriable = retriable;
  }
}

const DEFAULT_ORDER_BY = 'time_created';
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 1500
};

interface FetchPageResult {
  records: TransactionRecord[];
  hasMore: boolean;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

function retryPolicy(input?: Partial<RetryPolicy>): RetryPolicy {
  return {
    maxAttempts: input?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    baseDelayMs: input?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: input?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs
  };
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

function asTxnArray(input: unknown): GpTransactionApiShape[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((item): item is GpTransactionApiShape => isObject(item));
}

function readTxnArray(payload: unknown): GpTransactionApiShape[] {
  if (Array.isArray(payload)) {
    return asTxnArray(payload);
  }

  if (!isObject(payload)) {
    return [];
  }

  const topLevel =
    asTxnArray(payload.transactions) ||
    asTxnArray(payload.items) ||
    asTxnArray(payload.data);
  if (topLevel.length > 0) {
    return topLevel;
  }

  if (isObject(payload.data)) {
    const nested =
      asTxnArray(payload.data.transactions) ||
      asTxnArray(payload.data.items) ||
      asTxnArray(payload.data.results);
    if (nested.length > 0) {
      return nested;
    }
  }

  return [];
}

function readPagination(payload: unknown): { page?: number; totalPages?: number; hasMore?: boolean } {
  if (!isObject(payload)) {
    return {};
  }

  const page = asNumber(payload.page);
  const totalPages = asNumber(payload.total_pages ?? payload.totalPages);
  const hasMore = typeof payload.has_more === 'boolean' ? payload.has_more : undefined;

  if (isObject(payload.pagination)) {
    return {
      page: asNumber(payload.pagination.page) ?? page,
      totalPages: asNumber(payload.pagination.total_pages ?? payload.pagination.totalPages) ?? totalPages,
      hasMore:
        typeof payload.pagination.has_more === 'boolean'
          ? payload.pagination.has_more
          : hasMore
    };
  }

  return { page, totalPages, hasMore };
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetriableError(error: unknown): boolean {
  if (error instanceof TransactionsApiError) {
    return error.retriable;
  }
  return error instanceof TypeError;
}

function delayForAttempt(policy: RetryPolicy, attempt: number): number {
  const multiplier = 2 ** Math.max(0, attempt - 1);
  return Math.min(policy.baseDelayMs * multiplier, policy.maxDelayMs);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(run: (attempt: number) => Promise<T>, inputPolicy?: Partial<RetryPolicy>): Promise<T> {
  const policy = retryPolicy(inputPolicy);

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error: unknown) {
      const isLast = attempt === policy.maxAttempts;
      if (!isRetriableError(error) || isLast) {
        throw error;
      }
      await sleep(delayForAttempt(policy, attempt));
    }
  }

  throw new Error('transactions retry loop reached an impossible state');
}

export function buildTransactionsQueryParams(query: TransactionsQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set('from_time_created', query.fromTimeCreated);
  params.set('to_time_created', query.toTimeCreated);
  params.set('page', String(query.page ?? 1));
  params.set('page_size', String(query.pageSize));
  params.set('order', query.order);
  params.set('order_by', query.orderBy ?? DEFAULT_ORDER_BY);
  const accountName = asString(query.accountName);
  if (accountName) {
    params.set('account_name', accountName);
  }
  return params;
}

export async function fetchTransactionsPage(
  deps: TransactionsApiDeps,
  query: TransactionsQuery
): Promise<FetchPageResult> {
  return withRetry(async () => {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const { accessToken } = await deps.authProvider.getToken(deps.authInput);
    const endpoint = `${normalizeBaseUrl(deps.baseUrl)}/transactions?${buildTransactionsQueryParams(query).toString()}`;

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

      throw new TransactionsApiError(
        `GP API transactions request failed (${response.status})${details ? `: ${details}` : ''}`,
        response.status,
        isTransientStatus(response.status)
      );
    }

    const payload = await response.json();
    const txns = readTxnArray(payload).map((txn) => adaptGpTransaction(txn));
    const pagination = readPagination(payload);

    let hasMore = false;
    if (typeof pagination.hasMore === 'boolean') {
      hasMore = pagination.hasMore;
    } else if (pagination.page !== undefined && pagination.totalPages !== undefined) {
      hasMore = pagination.page < pagination.totalPages;
    } else {
      hasMore = txns.length >= query.pageSize;
    }

    const postFiltered = query.accountName
      ? txns.filter((txn) => txn.accountName?.toLowerCase() === query.accountName?.toLowerCase())
      : txns;

    return {
      records: postFiltered,
      hasMore
    };
  }, deps.retryPolicy);
}

export async function fetchRecentTransactionsPaginated(
  deps: TransactionsApiDeps,
  baseQuery: TransactionsQuery,
  options: PaginatedFetchOptions = {}
): Promise<TransactionRecord[]> {
  const records: TransactionRecord[] = [];
  const maxRecords = options.maxRecords ?? baseQuery.pageSize;
  const maxPages = options.maxPages ?? 3;
  let page = baseQuery.page ?? 1;

  for (let pagesFetched = 0; pagesFetched < maxPages; pagesFetched += 1) {
    const result = await fetchTransactionsPage(deps, {
      ...baseQuery,
      page
    });

    records.push(...result.records);
    if (records.length >= maxRecords) {
      return records.slice(0, maxRecords);
    }

    if (!result.hasMore) {
      return records;
    }

    page += 1;
  }

  return records;
}
