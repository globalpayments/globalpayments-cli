/**
 * The CLI boundary contract.
 *
 * Everything an automated caller needs to interoperate with gpcli is defined here
 * and nowhere else: the output envelope, the error taxonomy, the exit-code taxonomy,
 * the single output sink, and the self-describing manifest.
 *
 * Commands import from this module. Nothing in this module imports from commands.
 */
export {
  EXIT_CODES,
  EXIT_CODE_DESCRIPTIONS,
  RETRYABLE_EXIT_CODES,
  exitCodeName,
  type ExitCode,
  type ExitCodeName
} from './exit-codes.js';

export {
  ERROR_CODES,
  ERROR_CODE_EXIT,
  ERROR_CODE_REMEDIATION,
  GpCliError,
  toGpCliError,
  type ErrorCode,
  type SerializedError
} from './errors.js';

export {
  buildEnvelope,
  type Envelope,
  type EnvelopeInput,
  type NextAction,
  type Warning
} from './envelope.js';

export { emit, runCommand, nextActionsForError, renderErrorText, type CommandOutcome, type EmitOptions } from './emit.js';

export { buildManifest, ENVIRONMENT_VARIABLES, CONCEPTS, WORKFLOWS, type Manifest } from './manifest.js';

export { CLI_VERSION, ENVELOPE_SCHEMA_VERSION, RESULT_SCHEMA_VERSION } from './version.js';
