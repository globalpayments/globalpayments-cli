import type { Command } from 'commander';
import { runCommand } from '../contract/emit.js';
import { ERROR_CODES, GlobalPaymentsError } from '../contract/errors.js';
import { activeTheme, colorLevel, reloadUi, statusMark, t, unicodeEnabled, uiSettings } from '../ui/index.js';
import { keyValues } from '../ui/layout.js';
import { renderThemePreview } from '../ui/preview.js';
import { SETTING_DEFINITIONS, saveSettings, settingDefinition, type SettingKey, type SettingSource, type UiSettings } from '../ui/settings.js';
import { THEMES, THEME_NAMES } from '../ui/theme.js';
import { terminalColumns } from '../ui/capabilities.js';

export interface UiShowData {
  path: string;
  settings: UiSettings;
  sources: Record<SettingKey, SettingSource>;
  resolved: { theme: string; colorLevel: number; unicode: boolean };
  problems: string[];
}

const COLOR_LEVEL_NAMES = ['none', '16 colours', '256 colours', 'true colour'];

function showData(): UiShowData {
  const loaded = uiSettings();
  return {
    path: loaded.path,
    settings: loaded.settings,
    sources: loaded.sources,
    resolved: { theme: activeTheme().name, colorLevel: colorLevel(), unicode: unicodeEnabled() },
    problems: loaded.problems
  };
}

function renderShow(data: UiShowData): void {
  console.log();
  console.log(t.heading('Terminal settings'));
  const rows: Array<[string, string]> = SETTING_DEFINITIONS.map((definition) => {
    const value = data.settings[definition.key];
    const source = data.sources[definition.key];
    const note = source === 'env' ? t.muted(`from ${definition.env}`) : source === 'default' ? t.muted('default') : '';
    const resolved = definition.key === 'theme' && value === 'auto' ? `auto ${t.muted(`(${data.resolved.theme})`)}` : value;
    return [definition.key, `${t.accent(resolved)}  ${note}`.trimEnd()];
  });
  for (const line of keyValues(rows, { width: terminalColumns(), gap: 3, wrap: true })) console.log(line);
  console.log();
  for (const line of keyValues(
    [
      ['colour', COLOR_LEVEL_NAMES[data.resolved.colorLevel] ?? String(data.resolved.colorLevel)],
      ['symbols', data.resolved.unicode ? 'unicode' : 'ascii'],
      ['file', data.path]
    ],
    { width: terminalColumns(), gap: 3, wrap: true }
  )) {
    console.log(line);
  }
  for (const problem of data.problems) console.log(`${statusMark('warn')} ${problem}`);
}

function validate(key: string, value: string): { key: SettingKey; value: string } {
  const definition = settingDefinition(key);
  if (!definition) {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, `Unknown setting "${key}".`, {
      remediation: `Use one of: ${SETTING_DEFINITIONS.map((d) => d.key).join(', ')}.`,
      details: { settings: SETTING_DEFINITIONS.map((d) => d.key) }
    });
  }
  const normalized = value.trim().toLowerCase();
  if (!definition.values.includes(normalized)) {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, `"${value}" is not a valid ${key}.`, {
      remediation: `Use one of: ${definition.values.join(', ')}.`,
      details: { setting: key, values: definition.values }
    });
  }
  return { key: definition.key, value: normalized };
}

function writeSettings(changes: Partial<Record<SettingKey, string | null>>): string {
  try {
    const file = saveSettings(changes);
    reloadUi();
    return file;
  } catch (error) {
    throw new GlobalPaymentsError(ERROR_CODES.E_CONFIG_READ, `Could not save terminal settings: ${error instanceof Error ? error.message : String(error)}`, {
      remediation: 'Check that the settings directory is writable, or point GP_CLI_CONFIG_DIR at one that is.'
    });
  }
}

export function registerUiCommands(program: Command): void {
  const ui = program.command('ui').description('Personalise how the CLI looks in your terminal: theme, banner, symbols, motion');

  ui.command('show')
    .description('Show your terminal settings and where each value comes from')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { json?: boolean }) => {
      await runCommand<UiShowData>('ui.show', { json: options.json }, async () => ({
        data: showData(),
        render: renderShow,
        nextActions: [{ reason: 'Preview every theme side by side.', command: 'globalpayments ui themes' }]
      }));
    });

  ui.command('set')
    .argument('<key>', `Setting: ${SETTING_DEFINITIONS.map((d) => d.key).join(', ')}`)
    .argument('<value>', 'New value, e.g. gp-light, compact, ascii, off')
    .description('Change one terminal setting and save it for every future run')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (key: string, value: string, options: { json?: boolean }) => {
      await runCommand<{ key: SettingKey; value: string; path: string; overriddenBy?: string }>(
        'ui.set',
        { json: options.json },
        async () => {
          const setting = validate(key, value);
          const file = writeSettings({ [setting.key]: setting.value });
          const definition = settingDefinition(setting.key)!;
          const overridden = process.env[definition.env] ? definition.env : undefined;
          return {
            data: { ...setting, path: file, ...(overridden ? { overriddenBy: overridden } : {}) },
            ...(overridden
              ? { warnings: [{ code: 'W_ENV_OVERRIDE', message: `${overridden} is set, so it still wins over the saved ${setting.key} in this shell.` }] }
              : {}),
            render: (data) => {
              console.log(`${statusMark('pass')} ${data.key} set to ${t.accent(data.value)} ${t.muted(`(${data.path})`)}`);
            }
          };
        }
      );
    });

  ui.command('reset')
    .argument('[key]', 'Reset only this setting')
    .description('Put one setting, or all of them, back to the default')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (key: string | undefined, options: { json?: boolean }) => {
      await runCommand<{ reset: SettingKey[]; path: string }>('ui.reset', { json: options.json }, async () => {
        if (key && !settingDefinition(key)) validate(key, '');
        const keys = key ? [key as SettingKey] : SETTING_DEFINITIONS.map((d) => d.key);
        const file = writeSettings(Object.fromEntries(keys.map((k) => [k, null])));
        return {
          data: { reset: keys, path: file },
          render: (data) => console.log(`${statusMark('pass')} Reset ${data.reset.join(', ')} to the default.`)
        };
      });
    });

  ui.command('themes')
    .description('Preview every colour theme in your terminal')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { json?: boolean }) => {
      await runCommand<{ active: string; themes: Array<{ name: string; label: string; description: string }> }>(
        'ui.themes',
        { json: options.json },
        async () => ({
          data: {
            active: activeTheme().name,
            themes: THEME_NAMES.map((name) => ({ name, label: THEMES[name].label, description: THEMES[name].description }))
          },
          render: (data) => {
            console.log();
            for (const line of renderThemePreview(data.active as (typeof THEME_NAMES)[number])) console.log(line);
            if (colorLevel() === 0) {
              console.log(t.muted('Colour is off here (not a terminal, NO_COLOR or --no-color), so the themes look alike.'));
            }
          },
          nextActions: [{ reason: 'Switch theme for every future run.', command: 'globalpayments ui set theme gp-light' }]
        })
      );
    });
}
