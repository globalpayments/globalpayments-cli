import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Load environment variables from an env file into process.env.
 * Existing process.env keys are preserved (not overridden).
 */
export function loadEnvFile(envFile?: string): void {
  if (!envFile) {
    return;
  }

  const resolvedPath = path.resolve(envFile);
  const isDefaultDotEnv = envFile === '.env';

  if (!existsSync(resolvedPath)) {
    if (isDefaultDotEnv) {
      return;
    }
    throw new Error(`Env file not found: ${envFile}`);
  }

  try {
    process.loadEnvFile(resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load env file ${envFile}: ${message}`);
  }
}
