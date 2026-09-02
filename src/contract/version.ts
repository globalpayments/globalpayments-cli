/**
 * The single source of truth for the CLI's advertised version.
 *
 * `test/contract.test.ts` asserts this stays in lockstep with package.json, so the
 * constant can be bundled safely without a runtime manifest read.
 */
export const CLI_VERSION = '0.1.0';

/**
 * Version of the machine-readable output envelope.
 *
 * Bumped only on breaking changes to the envelope shape itself. Callers should
 * assert on this before parsing `data`.
 */
export const ENVELOPE_SCHEMA_VERSION = 1;

/**
 * Version of the persisted run-result artifact written to `.gpcli/results/`.
 * Independent of the envelope version: artifacts outlive invocations.
 */
export const RESULT_SCHEMA_VERSION = 1;
