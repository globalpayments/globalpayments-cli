import { Command } from 'commander';
import { t } from '../ui/index.js';
import { runCommand } from '../contract/emit.js';
import { ERROR_CODES, GlobalPaymentsError, toGlobalPaymentsError } from '../contract/errors.js';
import { createApiSession } from '../core/api-session.js';
import { environmentBaseUrl } from '../gpapi/auth.js';
import { requestGpApi } from '../gpapi/request.js';
import { parseDuration } from '../util/index.js';

export interface ApiAction {
  id?: string;
  action_type?: string;
  type?: string;
  resource?: string;
  resource_id?: string;
  resource_status?: string;
  time_created?: string;
  http_response_code?: string | number;
  response_code?: string | number;
  response_message?: string;
  app_id?: string;
}

export interface ApiLogEntry {
  id: string;
  timeCreated?: string;
  status: number;
  type: string;
  resource?: string;
  resourceId?: string;
  responseCode?: string;
  message?: string;
}

export interface LogsTailData {
  statusFilter: string;
  entries: ApiLogEntry[];
  interrupted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readActionList(payload: unknown): ApiAction[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord) as ApiAction[];
  }
  if (!isRecord(payload)) {
    return [];
  }

  const candidates = [payload.actions, payload.items, payload.data];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord) as ApiAction[];
    }
    if (isRecord(candidate)) {
      for (const nested of [candidate.actions, candidate.items, candidate.results]) {
        if (Array.isArray(nested)) {
          return nested.filter(isRecord) as ApiAction[];
        }
      }
    }
  }
  return [];
}

function numericStatus(value: string | number | undefined): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

function matchesStatus(status: number, filter: string): boolean {
  if (filter === '4xx') return status >= 400 && status < 500;
  if (filter === '5xx') return status >= 500 && status < 600;
  return status === Number(filter);
}

export function toLogEntry(action: ApiAction): ApiLogEntry | undefined {
  const status = numericStatus(action.http_response_code);
  if (status === undefined || !action.id) {
    return undefined;
  }

  const responseCode = action.response_code === undefined ? undefined : String(action.response_code);
  // GP often sends no response_message; repeating the code in its place printed it twice.
  const message = action.response_message && action.response_message !== responseCode ? action.response_message : undefined;
  return {
    id: action.id,
    timeCreated: action.time_created,
    status,
    type: action.action_type ?? action.type ?? 'UNKNOWN',
    resource: action.resource,
    resourceId: action.resource_id,
    responseCode,
    ...(message ? { message: message.slice(0, 300) } : {})
  };
}

async function fetchRecentFailures(
  baseUrl: string,
  authInput: Awaited<ReturnType<typeof createApiSession>>['authInput'],
  authProvider: Awaited<ReturnType<typeof createApiSession>>['authProvider'],
  filter: string,
  observerAppId: string,
  signal: AbortSignal
): Promise<ApiLogEntry[]> {
  const query = new URLSearchParams({
    page: '1',
    page_size: '100',
    order: 'DESC',
    order_by: 'TIME_CREATED'
  });
  const response = await requestGpApi(
    { authProvider, authInput, baseUrl, signal },
    { method: 'GET', path: `/actions?${query.toString()}` }
  );

  return readActionList(response.body)
    .filter((action) => !(action.app_id === observerAppId && (action.action_type ?? action.type) === 'ACTION_LIST'))
    .map(toLogEntry)
    .filter((entry): entry is ApiLogEntry => entry !== undefined && matchesStatus(entry.status, filter));
}

function renderEntry(entry: ApiLogEntry): string {
  const resource = [entry.resource, entry.resourceId].filter(Boolean).join('/');
  const details = [entry.type, resource, entry.responseCode, entry.message].filter(Boolean).join(' — ');
  return `${entry.timeCreated ?? 'unknown time'}  ${entry.status}  ${details}`;
}

function renderTailSummary(data: LogsTailData): void {
  console.log(t.muted(`Stopped; captured ${data.entries.length} matching request error(s) (${data.statusFilter}).`));
}

export function parseStatusFilter(value: string): string {
  if (value === '4xx' || value === '5xx' || /^\d{3}$/.test(value)) {
    if (value.length === 3 && (Number(value) < 100 || Number(value) > 599)) {
      throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, `Invalid HTTP status filter: ${value}.`);
    }
    return value;
  }
  throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, 'Status filter must be `4xx`, `5xx`, or a three-digit HTTP status.');
}

export function registerLogsCommand(program: Command): void {
  const logs = program.command('logs').description('Inspect API requests recorded by GP');

  logs
    .command('tail')
    .description('Watch GP action history for rejected API requests')
    .option('--status <class-or-code>', 'Filter by HTTP class (4xx, 5xx) or exact status', '4xx')
    .option('--once', 'Fetch one snapshot and exit')
    .option('--timeout <duration>', 'Stop after a duration (e.g. 30s, 5m)')
    .option('--interval <duration>', 'Polling interval while following', '3s')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: {
      status: string;
      once?: boolean;
      timeout?: string;
      interval: string;
      config?: string;
      envFile: string;
      json?: boolean;
    }) => {
      await runCommand<LogsTailData>('logs.tail', { json: options.json }, async (reportProgress) => {
        const statusFilter = parseStatusFilter(options.status);
        if (options.json && !options.once && !options.timeout) {
          throw new GlobalPaymentsError(
            ERROR_CODES.E_USAGE,
            '`logs tail --json` requires --once or --timeout so it can return a single JSON envelope.'
          );
        }

        const intervalMs = parseDuration(options.interval);
        if (!Number.isFinite(intervalMs) || intervalMs < 250) {
          throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, '--interval must be at least 250ms.');
        }

        const timeoutMs = options.timeout === undefined ? undefined : parseDuration(options.timeout);
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
          throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, '--timeout must be a positive duration.');
        }

        const { config, authInput, authProvider } = await createApiSession({
          configPath: options.config,
          envFile: options.envFile
        });
        const baseUrl = environmentBaseUrl(config.environment);
        let interrupted = false;
        let wake: (() => void) | undefined;
        const cancel = new AbortController();
        const entries: ApiLogEntry[] = [];
        const seen = new Set<string>();
        const stop = (): void => {
          interrupted = true;
          cancel.abort();
          wake?.();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);

        try {
          reportProgress(`Watching GP action history for ${statusFilter} errors; press Ctrl+C to stop.`);
          const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;

          do {
            if (interrupted) break;
            let batch: ApiLogEntry[];
            try {
              batch = await fetchRecentFailures(
                baseUrl, authInput, authProvider, statusFilter, authInput.appId, cancel.signal
              );
            } catch (error) {
              if (interrupted) break;
              // While following, one dropped poll should not end the tail; a snapshot
              // (--once) has nothing to fall back on, so it still fails.
              const gpError = toGlobalPaymentsError(error);
              if (options.once || gpError.code !== ERROR_CODES.E_NETWORK) throw error;
              reportProgress(t.warning(`Poll failed (${gpError.message}); retrying.`));
              batch = [];
            }
            const unseen = batch
              .filter((entry) => !seen.has(entry.id))
              .reverse();

            for (const entry of unseen) {
              seen.add(entry.id);
              entries.push(entry);
              reportProgress(renderEntry(entry));
            }

            if (options.once || interrupted || Date.now() >= deadline) {
              break;
            }
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now())));
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wake = undefined;
          } while (!interrupted);
        } finally {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        }

        const data: LogsTailData = { statusFilter, entries, interrupted };
        return {
          data,
          render: renderTailSummary,
          nextActions: [
            { reason: 'Inspect a specific transaction.', command: 'globalpayments transactions get <transactionId>' },
            { reason: 'Check configuration and API access.', command: 'globalpayments doctor --json' }
          ]
        };
      });
    });
}
