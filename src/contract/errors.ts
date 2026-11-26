import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { ConfigLoadError } from '../config/load.js';
import { TransactionsApiError } from '../gpapi/transactions.js';
import { ActionsApiError } from '../gpapi/actions.js';
import { GpApiRequestError, GpApiRequestInputError } from '../gpapi/request.js';
import { LocalWebhookDeliveryError, LocalWebhookInputError } from '../io/local-webhook.js';
import {
  AuthFailureError,
  InvalidCredentialsError,
  MalformedAuthResponseError,
  NetworkAuthError
} from '../gpapi/auth.js';

/**
 * The complete set of machine-stable error codes globalpayments can emit.
 *
 * A code is a promise: it identifies *what class of thing went wrong* independently
 * of the human message, which is free to change. Callers branch on `code`, never on
 * `message`.
 */
export const ERROR_CODES = {
  E_USAGE: 'E_USAGE',
  E_NO_PACKS_SELECTED: 'E_NO_PACKS_SELECTED',
  E_CONFIG_READ: 'E_CONFIG_READ',
  E_CONFIG_PARSE: 'E_CONFIG_PARSE',
  E_CONFIG_INVALID: 'E_CONFIG_INVALID',
  E_AUTH_MISSING_CREDENTIALS: 'E_AUTH_MISSING_CREDENTIALS',
  E_AUTH_INVALID_CREDENTIALS: 'E_AUTH_INVALID_CREDENTIALS',
  E_AUTH_FAILED: 'E_AUTH_FAILED',
  E_AUTH_MALFORMED_RESPONSE: 'E_AUTH_MALFORMED_RESPONSE',
  E_NETWORK: 'E_NETWORK',
  E_PACK_NOT_FOUND: 'E_PACK_NOT_FOUND',
  E_CASE_NOT_FOUND: 'E_CASE_NOT_FOUND',
  E_RESULT_NOT_FOUND: 'E_RESULT_NOT_FOUND',
  E_CERT_REQUIRED_CASES_FAILING: 'E_CERT_REQUIRED_CASES_FAILING',
  E_API_REJECTED: 'E_API_REJECTED',
  E_WEBHOOK_DELIVERY: 'E_WEBHOOK_DELIVERY',
  E_AGENT_SETUP_FAILED: 'E_AGENT_SETUP_FAILED',
  E_INTERNAL: 'E_INTERNAL'
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Static mapping from error code to the exit code it produces. */
export const ERROR_CODE_EXIT: Record<ErrorCode, ExitCode> = {
  E_USAGE: EXIT_CODES.USAGE,
  E_NO_PACKS_SELECTED: EXIT_CODES.USAGE,
  E_CONFIG_READ: EXIT_CODES.CONFIG,
  E_CONFIG_PARSE: EXIT_CODES.CONFIG,
  E_CONFIG_INVALID: EXIT_CODES.CONFIG,
  E_AUTH_MISSING_CREDENTIALS: EXIT_CODES.AUTH,
  E_AUTH_INVALID_CREDENTIALS: EXIT_CODES.AUTH,
  E_AUTH_FAILED: EXIT_CODES.AUTH,
  E_AUTH_MALFORMED_RESPONSE: EXIT_CODES.AUTH,
  E_NETWORK: EXIT_CODES.NETWORK,
  E_PACK_NOT_FOUND: EXIT_CODES.NOT_FOUND,
  E_CASE_NOT_FOUND: EXIT_CODES.NOT_FOUND,
  E_RESULT_NOT_FOUND: EXIT_CODES.NOT_FOUND,
  E_CERT_REQUIRED_CASES_FAILING: EXIT_CODES.CERT_FAILED,
  E_INTERNAL: EXIT_CODES.INTERNAL,
  E_API_REJECTED: EXIT_CODES.API_REJECTED,
  E_WEBHOOK_DELIVERY: EXIT_CODES.WEBHOOK_DELIVERY,
  E_AGENT_SETUP_FAILED: EXIT_CODES.SETUP_FAILED
};

/**
 * Default remediation for each error code: the concrete next step a caller should
 * take. Individual throw sites may override this with something more specific.
 */
export const ERROR_CODE_REMEDIATION: Record<ErrorCode, string> = {
  E_USAGE: 'Run `globalpayments explain --json` to see the exact flags this command accepts.',
  E_NO_PACKS_SELECTED:
    'Select at least one pack. Run `globalpayments packs list --json` to see available pack IDs, then pass `--cert <packId>`.',
  E_CONFIG_READ:
    'The config path does not exist or is unreadable. Omit `--config` to run from environment variables alone, or run `globalpayments init --with-config`.',
  E_CONFIG_PARSE: 'Fix the YAML syntax in the config file, then rerun.',
  E_CONFIG_INVALID:
    'Correct the offending field reported in `error.details.path`. Run `globalpayments explain --json` for the config schema.',
  E_AUTH_MISSING_CREDENTIALS:
    'Set GP_API_APP_ID and GP_API_APP_KEY in your environment or .env file, then run `globalpayments doctor --json`.',
  E_AUTH_INVALID_CREDENTIALS:
    'The GP API rejected these credentials. Verify GP_API_APP_ID / GP_API_APP_KEY and that GP_API_ENVIRONMENT matches the credentials.',
  E_AUTH_FAILED: 'Run `globalpayments doctor --json` to isolate which part of the auth handshake is failing.',
  E_AUTH_MALFORMED_RESPONSE:
    'The GP API returned an unexpected token payload. Verify GP_API_VERSION and retry; if it persists, report a bug.',
  E_NETWORK: 'Transient network failure. Retry the same command; check connectivity and any proxy settings.',
  E_PACK_NOT_FOUND: 'Run `globalpayments packs list --json` to see valid pack IDs.',
  E_CASE_NOT_FOUND:
    'Case IDs are namespaced as `<packId>:<caseId>`. Run `globalpayments cases list --json` to see valid IDs.',
  E_RESULT_NOT_FOUND: 'No saved result at that path. Run `globalpayments run --cert <packId>` first to produce one.',
  E_CERT_REQUIRED_CASES_FAILING:
    'Inspect the failing cases in `data.cases`. Each carries a `reason` explaining the mismatch; `globalpayments cases show <caseId> --json` reveals what the case expects.',
  E_INTERNAL: 'This is a bug in globalpayments. Rerun with `--json` and include the output in a bug report.',
  E_API_REJECTED: 'The GP API rejected the request. Review `error.details.response` and correct the request before retrying.',
  E_WEBHOOK_DELIVERY: 'Verify the local listener is running and the forwarding URL and handler are correct.',
  E_AGENT_SETUP_FAILED: 'Check the reported editor/setup step, npm/network access, and filesystem permissions, then rerun `globalpayments agent setup`.'
};

export interface GlobalPaymentsErrorOptions {
  remediation?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export interface SerializedError {
  code: ErrorCode;
  message: string;
  remediation: string;
  exitCode: ExitCode;
  details?: Record<string, unknown>;
}

/**
 * The single error type that crosses the CLI boundary.
 *
 * Everything thrown anywhere inside globalpayments is normalized into a GlobalPaymentsError by
 * {@link toGlobalPaymentsError} before it reaches a caller, so the shape of a failure is
 * identical no matter where it originated.
 */
export class GlobalPaymentsError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCode;
  readonly remediation: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: GlobalPaymentsErrorOptions = {}) {
    super(message);
    this.name = 'GlobalPaymentsError';
    this.code = code;
    this.exitCode = ERROR_CODE_EXIT[code];
    this.remediation = options.remediation ?? ERROR_CODE_REMEDIATION[code];
    this.details = options.details;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      remediation: this.remediation,
      exitCode: this.exitCode,
      ...(this.details ? { details: this.details } : {})
    };
  }
}

const CONFIG_ERROR_CODES: Record<string, ErrorCode> = {
  'read-failed': ERROR_CODES.E_CONFIG_READ,
  'yaml-parse': ERROR_CODES.E_CONFIG_PARSE,
  'schema-invalid': ERROR_CODES.E_CONFIG_INVALID
};

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

/**
 * Normalize any thrown value into a GlobalPaymentsError.
 *
 * This is the one place that knows how the internal error vocabulary (ConfigLoadError,
 * AuthFailureError, pack-loader Errors, ...) maps onto the external, stable code
 * taxonomy. Commands never classify errors themselves.
 */
/**
 * Turn a failed read or write of a file the caller named into an error about that file.
 * Without this an ENOENT fell through to E_RESULT_NOT_FOUND ("run a cert first") and
 * EACCES or EISDIR to E_INTERNAL ("this is a bug").
 */
export function fileAccessError(error: unknown, code: ErrorCode, action: string, filePath?: string): unknown {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  if (error instanceof GlobalPaymentsError || typeof errno !== 'string') return error;
  const target = filePath ?? (error as NodeJS.ErrnoException).path ?? 'a file';
  return new GlobalPaymentsError(code, `Could not ${action} ${target} (${errno}).`, {
    details: { path: target, errno },
    remediation: 'Check that the path is correct and that you have permission to use it, then rerun.',
    cause: error
  });
}

export function toGlobalPaymentsError(error: unknown): GlobalPaymentsError {
  if (error instanceof GlobalPaymentsError) {
    return error;
  }

  if (error instanceof GpApiRequestInputError) {
    return new GlobalPaymentsError(ERROR_CODES.E_USAGE, error.message, { cause: error });
  }

  if (error instanceof LocalWebhookInputError) {
    return new GlobalPaymentsError(ERROR_CODES.E_USAGE, error.message, { cause: error });
  }

  if (error instanceof LocalWebhookDeliveryError) {
    return new GlobalPaymentsError(ERROR_CODES.E_WEBHOOK_DELIVERY, error.message, {
      ...(error.status !== undefined ? { details: { status: error.status } } : {}),
      cause: error
    });
  }

  if (error instanceof GpApiRequestError) {
    const response = error.responseBody === undefined ? {} : { response: error.responseBody };
    if (error.status === 401 || error.status === 403) {
      return new GlobalPaymentsError(ERROR_CODES.E_AUTH_INVALID_CREDENTIALS, error.message, {
        details: { status: error.status, path: error.path, ...response },
        cause: error
      });
    }

    if (error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500) {
      // A write that got no answer, or a 5xx, may still have been applied by GP. Retrying
      // blindly can create a second transaction, so the generic "retry is reasonable"
      // advice for E_NETWORK is replaced for POST.
      const unconfirmedWrite = error.method === 'POST' && error.status !== 429;
      return new GlobalPaymentsError(ERROR_CODES.E_NETWORK, error.message, {
        details: {
          status: error.status,
          path: error.path,
          ...response,
          ...(unconfirmedWrite ? { mayHaveBeenProcessed: true } : {})
        },
        ...(unconfirmedWrite
          ? {
              remediation:
                'The sandbox may have processed this POST before the failure. Check with `globalpayments logs tail --once` or `globalpayments transactions get <id>` before sending it again.'
            }
          : {}),
        cause: error
      });
    }

    return new GlobalPaymentsError(ERROR_CODES.E_API_REJECTED, error.message, {
      details: { status: error.status, path: error.path, response: error.responseBody },
      cause: error
    });
  }

  if (error instanceof ConfigLoadError) {
    return new GlobalPaymentsError(CONFIG_ERROR_CODES[error.code] ?? ERROR_CODES.E_CONFIG_INVALID, error.message, {
      details: { configPath: error.configPath, configErrorCode: error.code },
      cause: error
    });
  }

  if (error instanceof InvalidCredentialsError) {
    return new GlobalPaymentsError(ERROR_CODES.E_AUTH_INVALID_CREDENTIALS, error.message, {
      details: { status: error.status, ...(error.code ? { gpErrorCode: error.code } : {}) },
      cause: error
    });
  }

  if (error instanceof MalformedAuthResponseError) {
    return new GlobalPaymentsError(ERROR_CODES.E_AUTH_MALFORMED_RESPONSE, error.message, { cause: error });
  }

  if (error instanceof NetworkAuthError) {
    return new GlobalPaymentsError(ERROR_CODES.E_NETWORK, error.message, { cause: error });
  }

  if (error instanceof AuthFailureError) {
    return new GlobalPaymentsError(ERROR_CODES.E_AUTH_FAILED, error.message, {
      details: { status: error.status, ...(error.code ? { gpErrorCode: error.code } : {}) },
      cause: error
    });
  }

  // A rejection from /transactions or /actions, not from the auth handshake. Tokens are cached, so
  // a revoked app or an unpermitted account surfaces here rather than as an
  // InvalidCredentialsError, and without this branch it would fall through to
  // E_INTERNAL — telling the caller to report a bug in this tool for what is actually
  // their credentials or a transient outage.
  if (error instanceof TransactionsApiError || error instanceof ActionsApiError) {
    if (error.status === 401 || error.status === 403) {
      return new GlobalPaymentsError(ERROR_CODES.E_AUTH_INVALID_CREDENTIALS, error.message, {
        details: { status: error.status },
        cause: error
      });
    }

    if (error.retriable || error.status >= 500 || error.status === 0) {
      return new GlobalPaymentsError(ERROR_CODES.E_NETWORK, error.message, {
        details: { status: error.status, retriable: error.retriable },
        cause: error
      });
    }

    // Any other status is a request this tool constructed being rejected on its
    // merits, which is a defect here. Fall through to E_INTERNAL deliberately.
  }

  // `fetch` rejects with a TypeError when the host is unreachable, DNS fails, or the
  // connection is refused. That is the textbook retryable network fault, not a bug.
  if (error instanceof TypeError && /fetch failed|network|ENOTFOUND|ECONNREFUSED/i.test(error.message)) {
    return new GlobalPaymentsError(ERROR_CODES.E_NETWORK, error.message, { cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);

  // pack-loader and pack-resolver throw plain Errors for missing packs.
  if (/pack .*not found/i.test(message)) {
    return new GlobalPaymentsError(ERROR_CODES.E_PACK_NOT_FOUND, message, { cause: error });
  }

  if (isFileNotFound(error)) {
    return new GlobalPaymentsError(ERROR_CODES.E_RESULT_NOT_FOUND, message, { cause: error });
  }

  return new GlobalPaymentsError(ERROR_CODES.E_INTERNAL, message, { cause: error });
}
