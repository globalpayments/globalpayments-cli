import pc from 'picocolors';
import { buildEnvelope, type Envelope, type NextAction, type Warning } from './envelope.js';
import { GlobalPaymentsError, toGlobalPaymentsError } from './errors.js';
import { EXIT_CODES, exitCodeName, type ExitCode } from './exit-codes.js';

/**
 * What a command handler returns. Everything here is optional except that a handler
 * either returns an outcome or throws; it never writes to stdout itself.
 */
export interface CommandOutcome<T> {
  /** The machine-readable payload. Becomes `envelope.data`. */
  data?: T;
  /** Non-fatal observations. */
  warnings?: Warning[];
  /** Concrete follow-up commands for the caller. */
  nextActions?: NextAction[];
  /**
   * Renders the human-facing view. Only invoked when `--json` is absent, so it may
   * use colour and multi-line layout freely.
   */
  render?: (data: T) => void;
  /**
   * A non-zero outcome that is a *result*, not a tool failure — e.g. required cases
   * failing. Must be paired with an error so the ok/exitCode invariant holds.
   */
  error?: GlobalPaymentsError;
}

export interface EmitOptions {
  json?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

function write(stream: NodeJS.WritableStream, text: string): void {
  stream.write(text);
}

/**
 * Render a failure for human eyes: code first (so it is greppable), then the
 * message, then the remediation, then any structured detail.
 */
export function renderErrorText(error: GlobalPaymentsError, stderr: NodeJS.WritableStream): void {
  write(stderr, `${pc.red('✗')} ${pc.bold(error.code)}  ${error.message}\n`);
  write(stderr, `  ${pc.gray('fix:')} ${error.remediation}\n`);
  if (error.details && Object.keys(error.details).length > 0) {
    write(stderr, `  ${pc.gray('details:')} ${JSON.stringify(error.details)}\n`);
  }
  write(stderr, `  ${pc.gray('exit:')} ${error.exitCode} (${exitCodeName(error.exitCode)})\n`);
}

function renderNextActionsText(actions: NextAction[], stdout: NodeJS.WritableStream): void {
  write(stdout, `\n${pc.cyan('Next:')}\n`);
  for (const action of actions) {
    write(stdout, `  ${pc.yellow(action.command)}\n    ${pc.gray(action.reason)}\n`);
  }
}

/**
 * The single output sink for the entire CLI.
 *
 * In JSON mode this writes exactly one JSON document to stdout and nothing else —
 * the property that makes globalpayments safely pipeable into an automated caller. In text
 * mode it delegates to the command's renderer and prints errors to stderr.
 *
 * Sets `process.exitCode` from the envelope so `ok` and the process status can never
 * diverge.
 */
export function emit<T>(
  command: string,
  outcome: CommandOutcome<T>,
  options: EmitOptions = {}
): Envelope<T> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const envelope = buildEnvelope<T>({
    command,
    data: outcome.data,
    error: outcome.error,
    warnings: outcome.warnings,
    nextActions: outcome.nextActions
  });

  if (options.json) {
    write(stdout, `${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    // Data first, then the failure. A failed certification run still has a summary
    // worth reading, so the two are not mutually exclusive.
    if (outcome.render && outcome.data !== undefined) {
      outcome.render(outcome.data);
    }
    if (outcome.error) {
      renderErrorText(outcome.error, stderr);
    }

    for (const warning of envelope.warnings ?? []) {
      write(stderr, `${pc.yellow('!')} ${pc.bold(warning.code)}  ${warning.message}\n`);
    }

    if (envelope.nextActions && envelope.nextActions.length > 0) {
      renderNextActionsText(envelope.nextActions, outcome.error ? stderr : stdout);
    }
  }

  process.exitCode = envelope.exitCode;
  return envelope;
}

/**
 * Wrap a command handler so that every failure — from anywhere in the call graph —
 * is normalized, classified, rendered, and turned into the correct exit code.
 *
 * This is why individual commands contain no try/catch and no error taxonomy: the
 * boundary owns both.
 */
export async function runCommand<T>(
  command: string,
  options: EmitOptions,
  handler: () => Promise<CommandOutcome<T>>
): Promise<Envelope<T>> {
  try {
    const outcome = await handler();
    return emit(command, outcome, options);
  } catch (error) {
    const gpError = toGlobalPaymentsError(error);
    return emit<T>(command, { error: gpError, nextActions: nextActionsForError(gpError) }, options);
  }
}

/** Suggest a recovery command based on the error class. */
export function nextActionsForError(error: GlobalPaymentsError): NextAction[] {
  switch (error.code) {
    case 'E_NO_PACKS_SELECTED':
    case 'E_PACK_NOT_FOUND':
      return [{ reason: 'List every pack this build can run.', command: 'globalpayments packs list --json' }];
    case 'E_CASE_NOT_FOUND':
      return [{ reason: 'List every resolved case ID.', command: 'globalpayments cases list --json' }];
    case 'E_AUTH_MISSING_CREDENTIALS':
    case 'E_AUTH_INVALID_CREDENTIALS':
    case 'E_AUTH_FAILED':
    case 'E_AUTH_MALFORMED_RESPONSE':
    case 'E_CONFIG_READ':
    case 'E_CONFIG_PARSE':
    case 'E_CONFIG_INVALID':
      return [{ reason: 'Diagnose configuration and credentials check by check.', command: 'globalpayments doctor --json' }];
    case 'E_NETWORK':
      return [{ reason: 'Network failures are usually transient; re-verify connectivity.', command: 'globalpayments doctor --json' }];
    case 'E_RESULT_NOT_FOUND':
      return [{ reason: 'Produce a result artifact before reading one.', command: 'globalpayments packs list --json' }];
    case 'E_USAGE':
    case 'E_INTERNAL':
    default:
      return [{ reason: 'Inspect the full machine-readable interface contract.', command: 'globalpayments explain --json' }];
  }
}

export { EXIT_CODES };
export type { ExitCode };
