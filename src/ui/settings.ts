import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { THEME_NAMES, type ThemeName } from './theme.js';

/**
 * Personal terminal preferences. These are about how the CLI looks on one
 * developer's machine, so they live in the user's config directory, never in the
 * project, and never affect `--json` output.
 *
 * Precedence, highest first: environment variable, settings file, default.
 */
export interface UiSettings {
  theme: 'auto' | ThemeName;
  banner: 'full' | 'compact' | 'off';
  icons: 'auto' | 'unicode' | 'ascii';
  motion: 'on' | 'off';
  hints: 'on' | 'off';
}

export type SettingKey = keyof UiSettings;

export interface SettingDefinition {
  key: SettingKey;
  values: readonly string[];
  env: string;
  description: string;
}

export const DEFAULT_SETTINGS: UiSettings = {
  theme: 'auto',
  banner: 'full',
  icons: 'auto',
  motion: 'on',
  hints: 'on'
};

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: 'theme',
    values: ['auto', ...THEME_NAMES],
    env: 'GP_CLI_THEME',
    description: 'Colour theme. auto picks gp or gp-light from the terminal background when it is advertised.'
  },
  {
    key: 'banner',
    values: ['full', 'compact', 'off'],
    env: 'GP_CLI_BANNER',
    description: 'Banner shown when the shell starts: full is the ASCII art, compact one line.'
  },
  {
    key: 'icons',
    values: ['auto', 'unicode', 'ascii'],
    env: 'GP_CLI_ICONS',
    description: 'Symbol set. ascii suits consoles without Unicode fonts.'
  },
  {
    key: 'motion',
    values: ['on', 'off'],
    env: 'GP_CLI_MOTION',
    description: 'Animated spinners. off shows a static line instead.'
  },
  {
    key: 'hints',
    values: ['on', 'off'],
    env: 'GP_CLI_HINTS',
    description: 'Live command palette and history suggestions in the shell.'
  }
];

export function settingDefinition(key: string): SettingDefinition | undefined {
  return SETTING_DEFINITIONS.find((definition) => definition.key === key);
}

/** Where personal CLI state lives: GP_CLI_CONFIG_DIR, then the platform convention. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.GP_CLI_CONFIG_DIR) return path.resolve(env.GP_CLI_CONFIG_DIR);
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'globalpayments');
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'globalpayments');
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'ui.json');
}

export type SettingSource = 'default' | 'file' | 'env';

export interface LoadedSettings {
  settings: UiSettings;
  sources: Record<SettingKey, SettingSource>;
  path: string;
  /** Problems worth telling the user about; the defaults were used instead. */
  problems: string[];
}

function isValid(key: SettingKey, value: unknown): boolean {
  const definition = settingDefinition(key);
  return typeof value === 'string' && Boolean(definition?.values.includes(value));
}

function readFile(file: string): { values: Partial<UiSettings>; problem?: string } {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: {} };
    return { values: {}, problem: `Could not read ${file}: ${(error as Error).message}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { values: {}, problem: `${file} is not a JSON object; using defaults.` };
    }
    return { values: parsed as Partial<UiSettings> };
  } catch {
    return { values: {}, problem: `${file} is not valid JSON; using defaults.` };
  }
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): LoadedSettings {
  const file = settingsPath(env);
  const { values, problem } = readFile(file);
  const problems: string[] = problem ? [problem] : [];
  const settings: UiSettings = { ...DEFAULT_SETTINGS };
  const sources = Object.fromEntries(SETTING_DEFINITIONS.map((d) => [d.key, 'default'])) as Record<SettingKey, SettingSource>;

  for (const definition of SETTING_DEFINITIONS) {
    const fromFile = values[definition.key];
    if (fromFile !== undefined) {
      if (isValid(definition.key, fromFile)) {
        (settings as unknown as Record<string, string>)[definition.key] = fromFile as string;
        sources[definition.key] = 'file';
      } else {
        problems.push(`Ignoring ${definition.key}=${JSON.stringify(fromFile)} in ${file}; expected ${definition.values.join(', ')}.`);
      }
    }
    const fromEnv = env[definition.env];
    if (fromEnv !== undefined && fromEnv !== '') {
      const value = fromEnv.trim().toLowerCase();
      if (isValid(definition.key, value)) {
        (settings as unknown as Record<string, string>)[definition.key] = value;
        sources[definition.key] = 'env';
      } else {
        problems.push(`Ignoring ${definition.env}=${fromEnv}; expected ${definition.values.join(', ')}.`);
      }
    }
  }

  return { settings, sources, path: file, problems };
}

/**
 * Persist changes on top of what the file already holds (never on top of the
 * effective settings, so a value that came from an environment variable is not
 * written to disk by accident). Keys equal to the default are dropped, so the
 * file stays small and future default changes still reach the user. `null`
 * removes a key. The write goes through a temporary file and a rename so a crash
 * never leaves half a file.
 */
export function saveSettings(
  changes: Partial<Record<SettingKey, string | null>>,
  env: NodeJS.ProcessEnv = process.env
): string {
  const file = settingsPath(env);
  const { values } = readFile(file);
  const merged: Record<string, unknown> = { ...values };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === DEFAULT_SETTINGS[key as SettingKey]) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
  return file;
}
