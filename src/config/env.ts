import { existsSync } from 'node:fs';
import path from 'node:path';
import { GpCliError, ERROR_CODES } from '../contract/errors.js';

/**
 * Load environment variables from an env file into process.env.
 *
 * A missing `.env` is tolerated because that is the default every command passes
 * when the caller said nothing; treating the default as a demand would make the
 * CLI unusable in any repo without one. Any *other* path was named explicitly by
 * the caller, so a missing file there is a genuine configuration error and is
 * reported as one rather than as an internal fault.
 */
export const DEFAULT_ENV_FILE = '.env';

export function loadEnvFile(envFile?: string): void {
  if (!envFile) {
    return;
  }

  const resolvedPath = path.resolve(envFile);

  if (!existsSync(resolvedPath)) {
    if (envFile === DEFAULT_ENV_FILE) {
      return;
    }
    throw new GpCliError(ERROR_CODES.E_CONFIG_READ, `Env file not found: ${envFile}`, {
      details: { path: resolvedPath },
      remediation: `Create ${envFile}, correct --env-file, or omit the flag to read credentials from the process environment.`
    });
  }

  try {
    process.loadEnvFile(resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GpCliError(ERROR_CODES.E_CONFIG_READ, `Unable to load env file ${envFile}: ${message}`, {
      details: { path: resolvedPath },
      remediation: `Ensure ${envFile} is readable and contains valid KEY=value lines.`
    });
  }
}
