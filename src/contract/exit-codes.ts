/**
 * Deterministic exit-code taxonomy.
 *
 * Every globalpayments invocation terminates with exactly one of these codes. The code is
 * the cheapest, most reliable signal available to an automated caller: it can be
 * branched on without parsing a single byte of output.
 *
 * Stability contract: these numbers are part of the public interface. Values are
 * never reassigned; new failure classes take the next free number.
 */
export const EXIT_CODES = {
  /** Command executed and every assertion it makes held. */
  OK: 0,
  /** Command executed correctly, but required certification cases are not passing. */
  CERT_FAILED: 1,
  /** The invocation itself was malformed: bad flags, missing arguments, no packs selected. */
  USAGE: 2,
  /** Configuration could not be found, parsed, or validated. */
  CONFIG: 3,
  /** Credentials are missing, rejected, or the token exchange failed. */
  AUTH: 4,
  /** The GP API was unreachable or returned an unusable transport-level response. */
  NETWORK: 5,
  /** A named resource (pack, case, result artifact) does not exist. */
  NOT_FOUND: 6,
  /** An unexpected internal error. Always a bug in globalpayments. */
  INTERNAL: 7
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];

/** Human-readable meaning for each exit code, surfaced by `globalpayments explain`. */
export const EXIT_CODE_DESCRIPTIONS: Record<ExitCodeName, string> = {
  OK: 'Success. The command ran and all of its assertions held.',
  CERT_FAILED:
    'The run completed but at least one required certification case is not passing. This is a certification outcome, not a tool error.',
  USAGE: 'The command was invoked incorrectly. Fix the arguments and retry.',
  CONFIG: 'Configuration is missing, unparseable, or invalid.',
  AUTH: 'Authentication with the GP API failed.',
  NETWORK: 'The GP API could not be reached. Usually transient; retry is reasonable.',
  NOT_FOUND: 'A referenced pack, case, or result artifact does not exist.',
  INTERNAL: 'Unexpected internal failure. Report this as a bug.'
};

/** Whether a caller can reasonably retry the same command unchanged. */
export const RETRYABLE_EXIT_CODES: readonly ExitCode[] = [EXIT_CODES.NETWORK];

export function exitCodeName(code: number): ExitCodeName | 'UNKNOWN' {
  const entry = Object.entries(EXIT_CODES).find(([, value]) => value === code);
  return (entry?.[0] as ExitCodeName) ?? 'UNKNOWN';
}
