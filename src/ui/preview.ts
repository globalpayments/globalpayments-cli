import { painter } from './color.js';
import { colorLevel, sym } from './index.js';
import { THEMES, THEME_NAMES, type ThemeName } from './theme.js';

/**
 * A sample of every theme, each drawn in its own colours, so a developer can
 * pick one by eye. Used by `globalpayments ui themes` and `/theme` in the shell.
 */
export function renderThemePreview(active: ThemeName): string[] {
  const level = colorLevel();
  const s = sym();
  const lines: string[] = [];
  for (const name of THEME_NAMES) {
    const theme = THEMES[name];
    const p = Object.fromEntries(Object.entries(theme.styles).map(([role, style]) => [role, painter(style, level)])) as Record<
      keyof typeof theme.styles,
      (text: string) => string
    >;
    const marker = name === active ? p.accent(s.pointer) : ' ';
    lines.push(`${marker} ${p.heading(name.padEnd(10))} ${p.muted(theme.description)}`);
    lines.push(
      `    ${p.badgeSandbox(' sandbox ')} ${p.success(s.pass)} passed  ${p.danger(s.fail)} failed  ${p.warning(s.warn)} warning  ${p.command('globalpayments doctor')}  ${p.link('docs')}`
    );
    lines.push('');
  }
  return lines;
}
