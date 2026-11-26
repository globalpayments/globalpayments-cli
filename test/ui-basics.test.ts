import { afterEach, describe, expect, it } from 'vitest';
import { padEnd, stringWidth, stripAnsi, truncate, wrapText } from '../src/ui/ansi.js';
import { detectBackground, detectColorLevel, detectUnicode, isInteractive, terminalColumns } from '../src/ui/capabilities.js';
import { painter, rgbToAnsi256 } from '../src/ui/color.js';
import { configureUi, resetUi, resolveThemeName, statusMark, sym, t } from '../src/ui/index.js';
import { BRAND, THEMES, THEME_NAMES } from '../src/ui/theme.js';
import { humanCommand, highlightJson, inlineCode, pruneEmpty } from '../src/ui/text.js';
import { flow, styledWords } from '../src/ui/layout.js';

afterEach(() => resetUi());

describe('ansi', () => {
  it('measures what the terminal shows, not string length', () => {
    expect(stringWidth('\x1B[1;38;2;38;42;255mglobal\x1B[22;39m')).toBe(6);
    expect(stringWidth('支付')).toBe(4);
    expect(stringWidth('é')).toBe(1);
    expect(stringWidth('\x1B]8;;https://x\x07link\x1B]8;;\x07')).toBe(4);
  });

  it('truncates styled text without leaking colour', () => {
    const cut = truncate('\x1B[31mabcdefgh\x1B[39m', 5);
    expect(stripAnsi(cut)).toBe('abcd…');
    expect(cut.endsWith('\x1B[0m…')).toBe(true);
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('abc', 0)).toBe('');
    expect(stringWidth(truncate('支付支付支付', 5))).toBeLessThanOrEqual(5);
  });

  it('pads to an exact width', () => {
    expect(padEnd('ab', 4)).toBe('ab  ');
    expect(stringWidth(padEnd('\x1B[1mabcdef\x1B[22m', 4))).toBe(4);
  });

  it('wraps on words, splits words longer than the line and keeps newlines', () => {
    expect(wrapText('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('a\nb', 10)).toEqual(['a', 'b']);
    for (const line of wrapText('Token acquired from https://apis.sandbox.globalpay.com/ucp; type=Bearer', 20)) {
      expect(stringWidth(line)).toBeLessThanOrEqual(20);
    }
  });
});

describe('capabilities', () => {
  const tty = { isTTY: true, argv: ['node', 'bin'], platform: 'darwin' as const };

  it('honours --no-color, NO_COLOR and FORCE_COLOR in that order', () => {
    expect(detectColorLevel({ ...tty, env: { COLORTERM: 'truecolor' } })).toBe(3);
    expect(detectColorLevel({ ...tty, env: { COLORTERM: 'truecolor', NO_COLOR: '1' } })).toBe(0);
    expect(detectColorLevel({ ...tty, env: { COLORTERM: 'truecolor', NO_COLOR: '' } })).toBe(3);
    expect(detectColorLevel({ ...tty, argv: ['node', 'bin', 'doctor', '--no-color'], env: { COLORTERM: 'truecolor' } })).toBe(0);
    expect(detectColorLevel({ ...tty, env: { FORCE_COLOR: '0', COLORTERM: 'truecolor' } })).toBe(0);
    expect(detectColorLevel({ isTTY: false, argv: [], env: { FORCE_COLOR: '2' } })).toBe(2);
    expect(detectColorLevel({ isTTY: false, argv: ['--color'], env: { NO_COLOR: '1' } })).toBe(1);
  });

  it('never colours a pipe, a dumb terminal, or flags after --', () => {
    expect(detectColorLevel({ isTTY: false, argv: [], env: { COLORTERM: 'truecolor' } })).toBe(0);
    expect(detectColorLevel({ ...tty, env: { TERM: 'dumb' } })).toBe(0);
    expect(detectColorLevel({ ...tty, argv: ['node', 'bin', '--', '--no-color'], env: { TERM: 'xterm-256color' } })).toBe(2);
  });

  it('reads the terminal type', () => {
    expect(detectColorLevel({ ...tty, env: { TERM_PROGRAM: 'Apple_Terminal' } })).toBe(2);
    expect(detectColorLevel({ ...tty, env: { TERM_PROGRAM: 'ghostty' } })).toBe(3);
    expect(detectColorLevel({ ...tty, env: { TERM: 'xterm' } })).toBe(1);
    expect(detectColorLevel({ ...tty, env: { WT_SESSION: 'x' }, platform: 'win32' })).toBe(3);
  });

  it('detects unicode support', () => {
    expect(detectUnicode({ env: { LANG: 'en_IE.UTF-8' }, platform: 'darwin' })).toBe(true);
    expect(detectUnicode({ env: {}, platform: 'linux' })).toBe(true);
    expect(detectUnicode({ env: { LANG: 'C' }, platform: 'linux' })).toBe(false);
    expect(detectUnicode({ env: { TERM: 'linux' }, platform: 'linux' })).toBe(false);
    expect(detectUnicode({ env: {}, platform: 'win32' })).toBe(false);
    expect(detectUnicode({ env: { WT_SESSION: '1' }, platform: 'win32' })).toBe(true);
  });

  it('reads the background from COLORFGBG when present', () => {
    expect(detectBackground({ COLORFGBG: '15;0' })).toBe('dark');
    expect(detectBackground({ COLORFGBG: '0;15' })).toBe('light');
    expect(detectBackground({ COLORFGBG: '0;default;7' })).toBe('light');
    expect(detectBackground({})).toBeUndefined();
  });

  it('treats CI and pipes as non-interactive', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true }, {})).toBe(true);
    expect(isInteractive({ isTTY: true }, { isTTY: true }, { CI: 'true' })).toBe(false);
    expect(isInteractive({ isTTY: false }, { isTTY: true }, {})).toBe(false);
    expect(terminalColumns({}, { COLUMNS: '132' })).toBe(132);
    expect(terminalColumns({}, {})).toBe(80);
  });
});

describe('colour', () => {
  it('emits nothing at level 0 and exact codes above it', () => {
    const style = { fg: { hex: BRAND.globalBlue, basic: 34 }, bold: true };
    expect(painter(style, 0)('x')).toBe('x');
    expect(painter(style, 1)('x')).toBe('\x1B[1m\x1B[34mx\x1B[22m\x1B[39m');
    expect(painter(style, 3)('x')).toContain('38;2;38;42;255');
    expect(painter(style, 2)('x')).toContain(`38;5;${rgbToAnsi256(38, 42, 255)}`);
    expect(painter({ bg: { hex: BRAND.globalBlue, basic: 34 } }, 1)('x')).toContain('\x1B[44m');
  });

  it('keeps the outer colour after a nested span closes', () => {
    const outer = painter({ fg: { basic: 31 } }, 1);
    const inner = painter({ fg: { basic: 32 } }, 1);
    expect(outer(`a${inner('b')}c`)).toBe('\x1B[31ma\x1B[32mb\x1B[39m\x1B[31mc\x1B[39m');
  });

  it('maps brand colours to sensible 256-colour indexes', () => {
    expect(rgbToAnsi256(0, 0, 0)).toBe(16);
    expect(rgbToAnsi256(255, 255, 255)).toBe(231);
    expect(rgbToAnsi256(128, 128, 128)).toBeGreaterThanOrEqual(232);
  });
});

describe('themes', () => {
  it('defines every role in every theme', () => {
    const roles = Object.keys(THEMES.gp.styles).sort();
    for (const name of THEME_NAMES) {
      expect(Object.keys(THEMES[name].styles).sort()).toEqual(roles);
    }
  });

  it('follows the brand guide: blue for positives, raspberry only for negatives, no green', () => {
    const gp = THEMES.gp.styles;
    expect(gp.success.fg?.hex).toBe(BRAND.pulseBlue);
    expect(gp.danger.fg?.hex).toBe(BRAND.raspberry);
    expect(gp.logo.bg?.hex).toBe(BRAND.globalBlue);
    expect(gp.badgeSandbox.bg?.hex).toBe(BRAND.globalBlue);
    expect(THEMES['gp-light'].styles.success.fg?.hex).toBe(BRAND.globalBlue);
    for (const name of ['gp', 'gp-light'] as const) {
      const hexes = Object.values(THEMES[name].styles).flatMap((style) => [style.fg?.hex, style.bg?.hex]).filter(Boolean);
      expect(hexes.every((hex) => (Object.values(BRAND) as string[]).includes(hex!))).toBe(true);
    }
  });

  it('returns plain text when colour is off', () => {
    configureUi({ level: 0, unicode: true });
    expect(t.success('ok')).toBe('ok');
    expect(t.badgeSandbox(' sandbox ')).toBe(' sandbox ');
    expect(statusMark('pass')).toBe('✓');
  });

  it('falls back to ASCII symbols', () => {
    configureUi({ level: 0, unicode: false });
    expect(statusMark('pass')).toBe('+');
    expect(statusMark('fail')).toBe('x');
    expect(sym().spinner).toEqual(['|', '/', '-', '\\']);
  });

  it('resolves auto from the terminal background', () => {
    expect(resolveThemeName('auto', { COLORFGBG: '0;15' })).toBe('gp-light');
    expect(resolveThemeName('auto', {})).toBe('gp');
    expect(resolveThemeName('classic', { COLORFGBG: '0;15' })).toBe('classic');
  });
});

describe('text helpers', () => {
  it('turns agent commands into human ones', () => {
    expect(humanCommand('globalpayments doctor --json', {})).toBe('globalpayments doctor');
    expect(humanCommand('globalpayments cases list --json --cert x', {})).toBe('globalpayments cases list --cert x');
    expect(humanCommand('globalpayments diagnose --json', { GP_CLI_SHELL: '1' })).toBe('/diagnose');
    expect(humanCommand('globalpayments run --jsonl', {})).toBe('globalpayments run --jsonl');
  });

  it('leaves prose alone without colour, and JSON valid either way', () => {
    configureUi({ level: 0 });
    expect(inlineCode('Run `globalpayments doctor`.')).toBe('Run `globalpayments doctor`.');
    const body = { a: 1, b: 'x', c: [true, null], d: { 'e:f': -2.5e3 } };
    expect(highlightJson(body)).toBe(JSON.stringify(body, null, 2));
    configureUi({ level: 3 });
    expect(JSON.parse(stripAnsi(highlightJson(body)))).toEqual(body);
    expect(highlightJson(body)).not.toBe(JSON.stringify(body, null, 2));
  });

  it('prunes empty fields and counts them', () => {
    const { value, removed } = pruneEmpty({ id: 'TRN_1', amount: '', card: { brand: '', last4: '' }, tags: [], keep: 0, off: false, n: null });
    expect(value).toEqual({ id: 'TRN_1', keep: 0, off: false });
    expect(removed).toBe(4);
    expect(pruneEmpty({ a: '' }).value).toEqual({});
    expect(pruneEmpty([]).value).toEqual([]);
  });
});

describe('flow', () => {
  it('wraps styled tokens between tokens and never past the width', () => {
    configureUi({ level: 3, unicode: true });
    const tokens = [...styledWords('Connect a sandbox app with', t.muted), t.command('/sandbox create'), ...styledWords('or take the tour', t.muted)];
    for (let width = 1; width <= 80; width += 1) {
      for (const line of flow(tokens, width)) expect(stringWidth(line), `width=${width}`).toBeLessThanOrEqual(width);
    }
    const lines = flow(tokens, 30).map(stripAnsi);
    expect(lines).toEqual(['Connect a sandbox app with', '/sandbox create or take the', 'tour']);
    // Every line opens and closes its own colour, so nothing bleeds into the next.
    for (const line of flow(tokens, 30)) expect(line.endsWith('\x1B[39m')).toBe(true);
  });

  it('keeps a multi-word token whole, and cuts one wider than the line', () => {
    expect(flow(['a', '/sandbox create', 'b'], 16)).toEqual(['a', '/sandbox create', 'b']);
    expect(flow(['averyveryverylongword'], 10)).toEqual(['averyvery…']);
    expect(flow(['', 'x', ''], 10)).toEqual(['x']);
    expect(flow([], 10)).toEqual([]);
  });

  it('splits words on any run of spaces', () => {
    expect(styledWords('  one  two ')).toEqual(['one', 'two']);
    expect(styledWords('a b', (w) => `<${w}>`)).toEqual(['<a>', '<b>']);
  });
});
