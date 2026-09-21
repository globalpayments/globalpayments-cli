import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import type { SerializedError } from './errors.js';
import { GlobalPaymentsError } from './errors.js';
import { CLI_VERSION, ENVELOPE_SCHEMA_VERSION } from './version.js';

/**
 * A concrete, executable suggestion for what to do next.
 *
 * This is the highest-value affordance the CLI offers an automated caller: rather
 * than inferring the next step from prose, the caller reads a literal command string
 * it can run. Every command populates these on both success and failure.
 */
export interface NextAction {
  /** Why this action is being suggested. */
  reason: string;
  /** A literal shell command, runnable as-is. */
  command: string;
}

/** A non-fatal observation worth surfacing without failing the command. */
export interface Warning {
  code: string;
  message: string;
}

/**
 * The universal output envelope.
 *
 * Every `--json` invocation of every command emits exactly one of these to stdout
 * and nothing else. The governing invariant, enforced by {@link buildEnvelope} and
 * asserted in tests, is:
 *
 *     ok === (exitCode === 0)
 *
 * There are no exceptions. A caller that checks the process exit code and a caller
 * that checks `ok` can never disagree.
 */
export interface Envelope<T = unknown> {
  schemaVersion: number;
  ok: boolean;
  command: string;
  cliVersion: string;
  timestamp: string;
  exitCode: ExitCode;
  data?: T;
  error?: SerializedError;
  warnings?: Warning[];
  nextActions?: NextAction[];
}

export interface EnvelopeInput<T> {
  /** Dotted command path, e.g. `run`, `cases.list`. Matches `globalpayments explain` ids. */
  command: string;
  data?: T;
  error?: GlobalPaymentsError;
  /** Overrides the exit code for successful-but-failing outcomes. Must be 0 when no error. */
  exitCode?: ExitCode;
  warnings?: Warning[];
  nextActions?: NextAction[];
  now?: () => Date;
}

/**
 * Construct an envelope, deriving `ok` and `exitCode` from the presence of an error
 * so the two can never be set inconsistently.
 */
export function buildEnvelope<T>(input: EnvelopeInput<T>): Envelope<T> {
  const exitCode: ExitCode = input.error ? input.error.exitCode : (input.exitCode ?? EXIT_CODES.OK);

  if (!input.error && exitCode !== EXIT_CODES.OK) {
    throw new Error(
      `buildEnvelope: non-zero exitCode ${exitCode} requires an error, otherwise the ok/exitCode invariant breaks.`
    );
  }

  const envelope: Envelope<T> = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    ok: exitCode === EXIT_CODES.OK,
    command: input.command,
    cliVersion: CLI_VERSION,
    timestamp: (input.now?.() ?? new Date()).toISOString(),
    exitCode
  };

  if (input.data !== undefined) {
    envelope.data = input.data;
  }
  if (input.error) {
    envelope.error = input.error.toJSON();
  }
  if (input.warnings && input.warnings.length > 0) {
    envelope.warnings = input.warnings;
  }
  if (input.nextActions && input.nextActions.length > 0) {
    envelope.nextActions = input.nextActions;
  }

  return envelope;
}
