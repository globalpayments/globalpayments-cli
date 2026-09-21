import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { ConfigLoadError } from '../config/load.js';
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
  E_INTERNAL: EXIT_CODES.INTERNAL
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
    'The GP API rejected these credentials. Verify GP_API_APP_ID / GP_API_APP_KEY and that GP_ENVIRONMENT matches the credentials.',
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
  E_INTERNAL: 'This is a bug in globalpayments. Rerun with `--json` and include the output in a bug report.'
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
export function toGlobalPaymentsError(error: unknown): GlobalPaymentsError {
  if (error instanceof GlobalPaymentsError) {
    return error;
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
