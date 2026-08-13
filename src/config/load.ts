import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { observerConfigSchema, packSchema, caseSchema } from './schema.js';
import type { CertificationCase, CertificationPack, ObserverConfig, ResolvedObserverConfig } from '../types/domain.js';

export const DEFAULT_CONFIG_PATH = '.gpcli/config.yaml';

export type ConfigLoadErrorCode = 'read-failed' | 'yaml-parse' | 'schema-invalid';

export class ConfigLoadError extends Error {
  constructor(
    public readonly code: ConfigLoadErrorCode,
    public readonly configPath: string,
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = 'ConfigLoadError';
    this.cause = cause;
  }
}

function interpolateString(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, key: string) => env[key] ?? '');
}

function interpolateEnvVars<T>(input: T, env: NodeJS.ProcessEnv): T {
  if (typeof input === 'string') {
    return interpolateString(input, env) as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => interpolateEnvVars(item, env)) as T;
  }

  if (input && typeof input === 'object') {
    const entries = Object.entries(input as Record<string, unknown>).map(([key, value]) => {
      return [key, interpolateEnvVars(value, env)];
    });
    return Object.fromEntries(entries) as T;
  }

  return input;
}

/**
 * Build a minimal config object from environment variables alone.
 * Used when no config file exists — the developer only needs GP_API_APP_ID
 * and GP_API_APP_KEY set in their environment.
 */
function configFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    auth: {
      mode: 'app-credentials',
      appId: env['GP_API_APP_ID'] ?? '',
      appKey: env['GP_API_APP_KEY'] ?? '',
      apiVersion: env['GP_API_VERSION'] ?? '2021-03-22'
    },
    environment: env['GP_ENVIRONMENT'] ?? 'sandbox',
    account: {
      accountName: env['GP_ACCOUNT_NAME']
    }
  };
}

export function resolveConfigPath(configPath?: string): string {
  return configPath ?? DEFAULT_CONFIG_PATH;
}

export async function loadObserverConfig(configPath?: string, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedObserverConfig> {
  const resolvedConfigPath = resolveConfigPath(configPath);

  // Allow env-only operation when no config file is present and no explicit path was given.
  const fileExists = existsSync(resolvedConfigPath);
  const configWasExplicit = configPath !== undefined;

  let rawInput: unknown;

  if (!fileExists && !configWasExplicit) {
    // No config file and no explicit path — build from env vars
    rawInput = configFromEnv(env);
  } else {
    let text: string;
    try {
      text = await readFile(resolvedConfigPath, 'utf8');
    } catch (error) {
      throw new ConfigLoadError(
        'read-failed',
        resolvedConfigPath,
        `Unable to read config at ${resolvedConfigPath}.`,
        error
      );
    }

    try {
      rawInput = parseYaml(text);
    } catch (error) {
      throw new ConfigLoadError(
        'yaml-parse',
        resolvedConfigPath,
        `Malformed YAML in ${resolvedConfigPath}.`,
        error
      );
    }
  }

  const interpolated = interpolateEnvVars(rawInput, env);

  let config: ObserverConfig;
  try {
    config = observerConfigSchema.parse(interpolated) as ObserverConfig;
  } catch (error) {
    if (error instanceof ZodError) {
      const firstIssue = error.issues[0];
      const issuePath = firstIssue?.path?.join('.') || 'config';
      const issueMessage = firstIssue?.message ?? 'invalid configuration value';
      throw new ConfigLoadError(
        'schema-invalid',
        resolvedConfigPath,
        `Invalid configuration at ${issuePath}: ${issueMessage}.`,
        error
      );
    }

    throw new ConfigLoadError(
      'schema-invalid',
      resolvedConfigPath,
      `Invalid configuration in ${resolvedConfigPath}.`,
      error
    );
  }

  const packsDirectory = config.packs?.directory
    ? path.isAbsolute(config.packs.directory)
      ? config.packs.directory
      : path.resolve(path.dirname(resolvedConfigPath), config.packs.directory)
    : undefined;

  return {
    ...config,
    packs: {
      directory: packsDirectory
    },
    configPath: resolvedConfigPath
  };
}

export async function loadPackManifest(packPath: string): Promise<Omit<CertificationPack, 'cases'>> {
  const text = await readFile(packPath, 'utf8');
  const parsed = parseYaml(text);
  const manifest = packSchema.parse(parsed);
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    extends: manifest.extends,
    metadata: manifest.metadata,
    tags: manifest.tags,
    casesDirectory: manifest.cases.directory,
    evaluators: manifest.evaluators,
    filters: manifest.filters
  };
}

export async function loadCaseFile(casePath: string): Promise<CertificationCase> {
  const text = await readFile(casePath, 'utf8');
  const parsed = parseYaml(text);
  return caseSchema.parse(parsed);
}

export function resolvePackPath(packsDir: string, packId: string): string {
  return path.join(packsDir, packId, 'pack.yaml');
}

export function resolvePackCasesDir(packsDir: string, packId: string, caseDirectory = 'cases'): string {
  return path.join(packsDir, packId, caseDirectory);
}
