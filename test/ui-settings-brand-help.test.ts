import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCli } from '../src/cli.js';
import { stringWidth, stripAnsi } from '../src/ui/ansi.js';
import { chooseWordmark, environmentBadge, lockup, renderBanner } from '../src/ui/brand.js';
import { COMMAND_GROUPS, EXAMPLES, SUMMARIES, formatCommanderError, groupedLeaves, leafCommands } from '../src/ui/help.js';
import { configureUi, resetUi } from '../src/ui/index.js';
import { configDir, loadSettings, saveSettings, settingsPath } from '../src/ui/settings.js';
import { tokenize } from '../src/shell/tokenize.js';
import { WORDMARK } from '../src/ui/wordmark.js';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gp-ui-'));
  env = { GP_CLI_CONFIG_DIR: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetUi();
});

describe('settings', () => {
  it('starts from defaults', () => {
    const loaded = loadSettings(env);
    expect(loaded.settings).toEqual({ theme: 'auto', banner: 'full', icons: 'auto', motion: 'on', hints: 'on' });
    expect(Object.values(loaded.sources).every((source) => source === 'default')).toBe(true);
    expect(loaded.problems).toEqual([]);
  });

  it('saves only what differs from the default, and removes keys reset to it', () => {
    saveSettings({ theme: 'gp-light', banner: 'compact' }, env);
    expect(JSON.parse(readFileSync(settingsPath(env), 'utf8'))).toEqual({ theme: 'gp-light', banner: 'compact' });
    saveSettings({ banner: 'full', theme: null }, env);
    expect(JSON.parse(readFileSync(settingsPath(env), 'utf8'))).toEqual({});
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('lets environment variables win without writing them to disk', () => {
    saveSettings({ theme: 'classic' }, env);
    const loaded = loadSettings({ ...env, GP_CLI_THEME: 'MONO', GP_CLI_ICONS: 'ascii' });
    expect(loaded.settings.theme).toBe('mono');
    expect(loaded.sources.theme).toBe('env');
    expect(loaded.settings.icons).toBe('ascii');
    saveSettings({ banner: 'off' }, { ...env, GP_CLI_THEME: 'mono' });
    expect(JSON.parse(readFileSync(settingsPath(env), 'utf8'))).toEqual({ theme: 'classic', banner: 'off' });
  });

  it('survives a broken file or bad values and says so', () => {
    writeFileSync(settingsPath(env), '{ not json');
    expect(loadSettings(env).settings.theme).toBe('auto');
    expect(loadSettings(env).problems[0]).toMatch(/not valid JSON/);
    writeFileSync(settingsPath(env), JSON.stringify({ theme: 'neon', banner: 'compact' }));
    const loaded = loadSettings({ ...env, GP_CLI_MOTION: 'sometimes' });
    expect(loaded.settings.theme).toBe('auto');
    expect(loaded.settings.banner).toBe('compact');
    expect(loaded.problems.join('\n')).toMatch(/theme="neon"/);
    expect(loaded.problems.join('\n')).toMatch(/GP_CLI_MOTION=sometimes/);
  });

  it('finds the config directory the platform expects', () => {
    expect(configDir({ GP_CLI_CONFIG_DIR: '/x/y' }, 'linux')).toBe(path.resolve('/x/y'));
    expect(configDir({ XDG_CONFIG_HOME: '/xdg', HOME: '/h' }, 'linux')).toBe(path.join('/xdg', 'globalpayments'));
    expect(configDir({ HOME: '/h' }, 'darwin')).toBe(path.join('/h', '.config', 'globalpayments'));
    expect(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toContain('globalpayments');
  });
});

describe('brand', () => {
  it('is plain printable ASCII with no trailing spaces', () => {
    for (const line of WORDMARK) {
      expect(line).toMatch(/^[\x20-\x7E]+$/);
      expect(line).toBe(line.trimEnd());
    }
    expect(WORDMARK.at(-1)).toContain('DEVELOPER CLI');
  });

  it('is the figlet standard rendering of Global Payments', () => {
    // Pinned against `figlet -f standard "Global Payments"`, plus the product line.
    expect(WORDMARK.slice(0, 5).join('\n')).toBe(
      [
        '  ____ _       _           _   ____                                  _',
        ' / ___| | ___ | |__   __ _| | |  _ \\ __ _ _   _ _ __ ___   ___ _ __ | |_ ___',
        "| |  _| |/ _ \\| '_ \\ / _` | | | |_) / _` | | | | '_ ` _ \\ / _ \\ '_ \\| __/ __|",
        '| |_| | | (_) | |_) | (_| | | |  __/ (_| | |_| | | | | | |  __/ | | | |_\\__ \\',
        ' \\____|_|\\___/|_.__/ \\__,_|_| |_|   \\__,_|\\__, |_| |_| |_|\\___|_| |_|\\__|___/'
      ].join('\n')
    );
    // The tail of the y sits right under the start of its bowl.
    expect(WORDMARK[5]!.indexOf('|___/')).toBe(WORDMARK[4]!.indexOf('\\__, |'));
  });

  it('shows the wordmark when it fits and never overflows', () => {
    configureUi({ level: 3, unicode: true });
    const width = Math.max(...WORDMARK.map((line) => line.length));
    expect(chooseWordmark(width, 40)).toBe(WORDMARK);
    expect(chooseWordmark(width - 1, 40)).toBeUndefined();
    expect(chooseWordmark(200, 15)).toBeUndefined();
    expect(chooseWordmark(200, 16)).toBe(WORDMARK);
    for (let columns = 20; columns <= 200; columns += 1) {
      for (const line of renderBanner({ mode: 'full', columns, rows: 40, indent: 1 })) {
        expect(stringWidth(line), `columns=${columns}`).toBeLessThanOrEqual(columns);
      }
    }
    expect(renderBanner({ mode: 'full', columns: 80, rows: 40, indent: 1 })).toEqual(WORDMARK.map((line) => ` ${line}`));
    expect(renderBanner({ mode: 'full', columns: 80, rows: 40, indent: 2 })[0]).toBe(`  ${WORDMARK[0]}`);
  });

  it('never colours the wordmark, whatever the theme or console', () => {
    for (const theme of ['gp', 'gp-light', 'classic', 'mono'] as const) {
      for (const unicode of [true, false]) {
        configureUi({ level: 3, unicode, theme });
        expect(renderBanner({ mode: 'full', columns: 120, rows: 40 })).toEqual(WORDMARK.map((line) => ` ${line}`));
      }
    }
  });

  it('falls back to the lockup for compact mode and small terminals', () => {
    configureUi({ level: 3, unicode: true });
    expect(renderBanner({ mode: 'compact', columns: 200, rows: 40 })).toEqual([` ${lockup()}`]);
    expect(renderBanner({ mode: 'off', columns: 200, rows: 40 })).toEqual([]);
    expect(renderBanner({ mode: 'full', columns: 60, rows: 40 })).toEqual([` ${lockup()}`]);
    expect(renderBanner({ mode: 'full', columns: 200, rows: 10 })).toEqual([` ${lockup()}`]);
    configureUi({ level: 0, unicode: true });
    expect(renderBanner({ mode: 'full', columns: 200, rows: 40 }).join('')).not.toContain('\x1B');
    expect(lockup()).toBe('global payments');
    expect(environmentBadge('production')).toBe('[PRODUCTION]');
    expect(environmentBadge('none')).toBe('[no credentials]');
  });
});

/** Walk an example the way commander would, without running anything. */
function checkExample(root: Command, example: string): string | undefined {
  const { args, error } = tokenize(example.replace(/^eval "\$\((.*)\)"$/, '$1').replace(/\s*>.*$/, ''));
  if (error) return error;
  if (args[0] !== 'globalpayments') return 'does not start with globalpayments';
  let command = root;
  let index = 1;
  while (index < args.length) {
    const next = command.commands.find((child) => child.name() === args[index]);
    if (!next) break;
    command = next;
    index += 1;
  }
  if (command.commands.length > 0 && command !== root) return `stops at group ${command.name()}`;
  let positional = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith('-')) {
      const option = command.options.find((o) => o.long === arg || o.short === arg);
      if (!option && arg !== '--help') return `unknown option ${arg} on ${command.name()}`;
      if (option && (option.required || option.optional)) index += 1;
    } else {
      positional += 1;
    }
  }
  const required = command.registeredArguments.filter((a) => a.required).length;
  if (command !== root && positional < required) return `missing arguments for ${command.name()}`;
  if (command !== root && positional > command.registeredArguments.length && !command.registeredArguments.some((a) => a.variadic)) {
    return `too many arguments for ${command.name()}`;
  }
  return undefined;
}

describe('help', () => {
  const root = buildCli();

  it('files every command under exactly one heading, with a summary', () => {
    const leaves = leafCommands(root).map((leaf) => leaf.path);
    const grouped = COMMAND_GROUPS.flatMap((group) => group.commands);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...leaves].sort()).toEqual([...grouped].sort());
    expect(groupedLeaves(root).map((group) => group.title)).not.toContain('More');
    for (const leaf of leaves) expect(SUMMARIES[leaf], leaf).toBeTruthy();
    expect(leaves).not.toContain('__complete');
  });

  it('only shows examples that commander would accept', () => {
    for (const [path, examples] of Object.entries(EXAMPLES)) {
      if (path !== '') expect(leafCommands(root).map((leaf) => leaf.path), path).toContain(path);
      for (const example of examples) {
        expect(checkExample(root, example), example).toBeUndefined();
      }
    }
  });

  it('renders the root help within 80 columns, with every command in it', () => {
    configureUi({ level: 0, unicode: true });
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '80';
    try {
      const help = root.helpInformation();
      for (const line of help.split('\n')) expect(stringWidth(line), line).toBeLessThanOrEqual(80);
      for (const leaf of leafCommands(root)) expect(help).toContain(leaf.term);
      expect(help).toContain('Get started');
      expect(help).toContain('--no-color');
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });

  it('renders command help with usage, options and examples', () => {
    configureUi({ level: 0, unicode: true });
    const get = root.commands.find((c) => c.name() === 'api')!.commands.find((c) => c.name() === 'get')!;
    const help = get.helpInformation();
    expect(help).toContain('globalpayments api get');
    expect(help).toContain('Usage');
    expect(help).toContain('--env-file <path>');
    expect(help).toContain('globalpayments api get /transactions?page_size=5');
  });

  it('points commander errors at the right help', () => {
    configureUi({ level: 0, unicode: true });
    const message = stripAnsi(formatCommanderError("error: unknown option '--jsn'\n(Did you mean --json?)", 'doctor'));
    expect(message).toContain("✗ unknown option '--jsn'");
    expect(message).toContain('Did you mean --json?');
    expect(message).toContain('globalpayments doctor --help');
  });
});

describe('settings file location', () => {
  it('does not create anything until something is saved', () => {
    loadSettings(env);
    expect(existsSync(settingsPath(env))).toBe(false);
  });
});
