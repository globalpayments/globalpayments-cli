import { detectBackground, detectColorLevel, detectUnicode, type ColorLevel } from './capabilities.js';
import { painter, type Paint, type TextStyle } from './color.js';
import { loadSettings, type LoadedSettings, type UiSettings } from './settings.js';
import { ASCII_SYMBOLS, UNICODE_SYMBOLS, type SymbolSet } from './symbols.js';
import { THEMES, type Theme, type ThemeName } from './theme.js';

/**
 * The one place output styling is decided. Renderers ask for roles (`t.success`,
 * `t.command`) and symbols (`sym().pass`); this module turns those into escape
 * codes for the current terminal, theme and preferences, or into plain text when
 * output is not going to a person.
 */
interface UiState {
  level: ColorLevel;
  unicode: boolean;
  motion: boolean;
  theme: Theme;
  loaded: LoadedSettings;
  paints: Record<keyof Theme['styles'], Paint>;
}

export interface UiOverrides {
  level?: ColorLevel;
  unicode?: boolean;
  motion?: boolean;
  theme?: ThemeName;
  env?: NodeJS.ProcessEnv;
}

let state: UiState | undefined;
let overrides: UiOverrides = {};

export function resolveThemeName(setting: UiSettings['theme'], env: NodeJS.ProcessEnv = process.env): ThemeName {
  if (setting !== 'auto') return setting;
  return detectBackground(env) === 'light' ? 'gp-light' : 'gp';
}

function build(): UiState {
  const env = overrides.env ?? process.env;
  const loaded = loadSettings(env);
  const level = overrides.level ?? detectColorLevel({ env });
  const unicode =
    overrides.unicode ?? (loaded.settings.icons === 'auto' ? detectUnicode({ env }) : loaded.settings.icons === 'unicode');
  const theme = THEMES[overrides.theme ?? resolveThemeName(loaded.settings.theme, env)];
  const motion = overrides.motion ?? loaded.settings.motion === 'on';
  const paints = Object.fromEntries(
    Object.entries(theme.styles).map(([role, style]) => [role, painter(style as TextStyle, level)])
  ) as UiState['paints'];
  return { level, unicode, motion, theme, loaded, paints };
}

function current(): UiState {
  state ??= build();
  return state;
}

/** Override detection (tests, `--no-color`, a theme change in the shell). Pass {} to clear. */
export function configureUi(next: UiOverrides): void {
  overrides = { ...overrides, ...next };
  state = undefined;
}

export function resetUi(): void {
  overrides = {};
  state = undefined;
}

/** Forget cached settings so the next call re-reads the settings file. */
export function reloadUi(): void {
  state = undefined;
}

export function colorLevel(): ColorLevel {
  return current().level;
}

export function activeTheme(): Theme {
  return current().theme;
}

export function uiSettings(): LoadedSettings {
  return current().loaded;
}

export function motionEnabled(): boolean {
  return current().motion;
}

export function unicodeEnabled(): boolean {
  return current().unicode;
}

export function sym(): SymbolSet {
  return current().unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS;
}

/** Paint with a one-off style at the current colour level. */
export function paint(style: TextStyle, text: string): string {
  return painter(style, current().level)(text);
}

const role =
  (name: keyof Theme['styles']): Paint =>
  (text: string) =>
    current().paints[name](text);

/** Semantic text roles. */
export const t = {
  heading: role('heading'),
  strong: role('strong'),
  accent: role('accent'),
  success: role('success'),
  danger: role('danger'),
  warning: role('warning'),
  muted: role('muted'),
  command: role('command'),
  link: role('link'),
  logo: role('logo'),
  selected: role('selected'),
  badgeSandbox: role('badgeSandbox'),
  badgeProduction: role('badgeProduction'),
  badgeNeutral: role('badgeNeutral')
};

/** Status glyph in its colour: pass, fail, pending, skip, warn. */
export function statusMark(status: 'pass' | 'fail' | 'pending' | 'skip' | 'warn' | 'info'): string {
  const s = sym();
  switch (status) {
    case 'pass':
      return t.success(s.pass);
    case 'fail':
      return t.danger(s.fail);
    case 'warn':
      return t.warning(s.warn);
    case 'info':
      return t.accent(s.info);
    case 'skip':
      return t.muted(s.skip);
    default:
      return t.muted(s.pending);
  }
}

export { stringWidth, stripAnsi, truncate, padEnd, padStart, wrapText } from './ansi.js';
