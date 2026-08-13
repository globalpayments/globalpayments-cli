import type { PollWindow, TransactionRecord } from '../types/domain.js';
import { environmentBaseUrl, type AuthInput, type AuthProvider } from './auth.js';
import {
  fetchRecentTransactionsPaginated,
  type RetryPolicy,
  type TransactionsApiDeps
} from './transactions.js';
import { fetchActionsPage, type ActionsApiDeps, type ActionsQuery, type ActionRecord } from './actions.js';

export interface GpApiClient {
  fetchRecentTransactions(window: PollWindow): Promise<TransactionRecord[]>;
  fetchActions(query: ActionsQuery): Promise<ActionRecord[]>;
}

export interface GpApiClientDeps {
  authProvider: AuthProvider;
  authInput: AuthInput;
  accountName?: string;
  fetchImpl?: typeof fetch;
  retryPolicy?: Partial<RetryPolicy>;
  maxPagesPerPoll?: number;
  maxRecordsPerPoll?: number;
}

export class HttpGpApiClient implements GpApiClient {
  constructor(private readonly deps: GpApiClientDeps) {}

  async fetchRecentTransactions(window: PollWindow): Promise<TransactionRecord[]> {
    const transportDeps: TransactionsApiDeps = {
      authProvider: this.deps.authProvider,
      authInput: this.deps.authInput,
      baseUrl: environmentBaseUrl(this.deps.authInput.environment),
      apiVersion: this.deps.authInput.apiVersion,
      fetchImpl: this.deps.fetchImpl,
      retryPolicy: this.deps.retryPolicy
    };

    return fetchRecentTransactionsPaginated(
      transportDeps,
      {
        fromTimeCreated: window.fromTimeCreated,
        toTimeCreated: window.toTimeCreated,
        page: window.page,
        pageSize: window.pageSize,
        order: window.order,
        orderBy: 'time_created',
        accountName: this.deps.accountName
      },
      {
        maxPages: this.deps.maxPagesPerPoll,
        maxRecords: this.deps.maxRecordsPerPoll
      }
    );
  }

  async fetchActions(query: ActionsQuery): Promise<ActionRecord[]> {
    const transportDeps: ActionsApiDeps = {
      authProvider: this.deps.authProvider,
      authInput: this.deps.authInput,
      baseUrl: environmentBaseUrl(this.deps.authInput.environment),
      apiVersion: this.deps.authInput.apiVersion,
      fetchImpl: this.deps.fetchImpl
    };

    return fetchActionsPage(transportDeps, query);
  }
}

export class StubGpApiClient implements GpApiClient {
  constructor(private readonly _deps: GpApiClientDeps) {}

  async fetchRecentTransactions(_window: PollWindow): Promise<TransactionRecord[]> {
    return [];
  }

  async fetchActions(_query: ActionsQuery): Promise<ActionRecord[]> {
    return [];
  }
}
