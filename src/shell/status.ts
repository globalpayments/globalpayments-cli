import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG_PATH, loadObserverConfig } from '../config/load.js';

/**
 * Where commands run from the shell will send requests, worked out the same way
 * the commands do it (process environment first, then ./.env, then the project
 * config file) but without loading anything into this process: the shell's own
 * environment must stay clean so every command it runs reads .env fresh.
 */
export interface ShellStatus {
  environment?: 'sandbox' | 'production';
  /** App ID with the middle masked. Never the key. */
  appId?: string;
  hasKey: boolean;
  /** Where the credentials came from. */
  source: 'environment' | '.env' | 'config' | 'none';
  configPath?: string;
  envFile?: string;
  problem?: string;
}

/** Parse KEY=value lines the way .env files are usually written. */
export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? '';
    const quoted = /^(['"`])([\s\S]*)\1$/.exec(value);
    if (quoted) {
      value = quoted[1] === '"' ? quoted[2]!.replace(/\\n/g, '\n') : quoted[2]!;
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]!] = value;
  }
  return values;
}

export function maskId(id: string): string {
  if (id.length <= 8) return `${id.slice(0, 2)}…`;
  return `${id.slice(0, 4)}…${id.slice(-3)}`;
}

export async function readShellStatus(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): Promise<ShellStatus> {
  const envFile = path.join(cwd, '.env');
  let fromFile: Record<string, string> = {};
  if (existsSync(envFile)) {
    try {
      fromFile = parseDotEnv(readFileSync(envFile, 'utf8'));
    } catch {
      fromFile = {};
    }
  }
  // The process environment wins over .env, matching how the commands load it.
  const merged: NodeJS.ProcessEnv = { ...fromFile, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== '')) };
  const configPath = path.join(cwd, DEFAULT_CONFIG_PATH);
  const hasConfig = existsSync(configPath);

  if (!hasConfig && !merged.GP_API_APP_ID) {
    return {
      environment: merged.GP_API_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
      hasKey: Boolean(merged.GP_API_APP_KEY),
      source: 'none',
      ...(existsSync(envFile) ? { envFile: '.env' } : {})
    };
  }

  try {
    // Name the config file only when it exists; otherwise configure from the environment alone.
    const config = await loadObserverConfig(hasConfig ? configPath : undefined, merged);
    const auth = config.auth as { appId?: string; appKey?: string } | undefined;
    const appId = auth?.appId ?? '';
    const hasKey = Boolean(auth?.appKey);
    const source: ShellStatus['source'] = !appId
      ? 'none'
      : hasConfig
        ? 'config'
        : env.GP_API_APP_ID
          ? 'environment'
          : '.env';
    return {
      environment: config.environment,
      ...(appId ? { appId: maskId(appId) } : {}),
      hasKey,
      source,
      ...(hasConfig ? { configPath: DEFAULT_CONFIG_PATH } : {}),
      ...(existsSync(envFile) ? { envFile: '.env' } : {})
    };
  } catch (error) {
    return {
      hasKey: false,
      source: 'none',
      ...(hasConfig ? { configPath: DEFAULT_CONFIG_PATH } : {}),
      problem: error instanceof Error ? error.message : String(error)
    };
  }
}
