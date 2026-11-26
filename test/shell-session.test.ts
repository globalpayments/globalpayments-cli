import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCli, stripGlobalFlags } from '../src/cli.js';
import { completeWords, completionScript, SHELLS } from '../src/commands/completion.js';
import { shellCatalog } from '../src/commands/shell.js';
import { stripAnsi } from '../src/ui/ansi.js';
import { configureUi, resetUi } from '../src/ui/index.js';
import { withSpinner } from '../src/ui/spinner.js';
import { runShell, Shell, type RunResult, type ShellDependencies } from '../src/shell/shell.js';
import type { ShellStatus } from '../src/shell/status.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'gp-shell-'));
  configureUi({ level: 0, unicode: true, env: { GP_CLI_CONFIG_DIR: dir } });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetUi();
});

function harness(options: { status?: ShellStatus; results?: RunResult[]; columns?: number; rows?: number } = {}) {
  const runs: string[][] = [];
  const results = [...(options.results ?? [])];
  const chunks: string[] = [];
  const deps: ShellDependencies = {
    program: buildCli(),
    version: '9.9.9',
    input: Object.assign(Readable.from([]), { isTTY: false }) as unknown as ShellDependencies['input'],
    output: { write: (chunk: string) => chunks.push(chunk), isTTY: false, columns: options.columns ?? 100, rows: options.rows ?? 40 },
    run: async (args) => {
      runs.push(args);
      return results.shift() ?? { code: 0, signal: null };
    },
    status: async () => options.status ?? { hasKey: true, source: '.env', environment: 'sandbox', appId: 'UJqP…GRV', envFile: '.env' },
    completionData: async () => ({ packIds: ['global-core'], caseAddresses: [] }),
    env: { GP_CLI_CONFIG_DIR: dir },
    historyFile: null
  };
  const shell = new Shell(deps);
  return { shell, runs, deps, output: () => stripAnsi(chunks.join('')) };
}

describe('shell dispatch', () => {
  it('runs commands with or without the slash, and pasted full commands', async () => {
    const { shell, runs } = harness();
    await shell.dispatch('/doctor');
    await shell.dispatch('doctor --json');
    await shell.dispatch('globalpayments api get "/transactions?page_size=5"');
    await shell.dispatch('npx @globalpayments/cli packs list');
    expect(runs).toEqual([['doctor'], ['doctor', '--json'], ['api', 'get', '/transactions?page_size=5'], ['packs', 'list']]);
  });

  it('shows a group on its own as help', async () => {
    const { shell, runs } = harness();
    await shell.dispatch('/api');
    await shell.dispatch('/help api get');
    expect(runs).toEqual([['api', '--help'], ['api', 'get', '--help']]);
  });

  it('keeps unknown lines, like a pasted key, out of history', async () => {
    const historyFile = path.join(dir, 'history');
    const { shell, deps } = harness();
    const withHistory = new Shell({ ...deps, historyFile });
    await withHistory.dispatch('UJqPrAhrDkGzzNoFInpzKqoI8vfZtGRV');
    await withHistory.dispatch('/doctor');
    await withHistory.dispatch('/version');
    expect(readFileSync(historyFile, 'utf8').trim().split('\n')).toEqual(['/doctor', '/version']);
    void shell;
  });

  it('suggests a fix for an unknown command and runs nothing', async () => {
    const { shell, runs, output } = harness();
    expect(await shell.dispatch('/hlep')).toBe(true);
    expect(await shell.dispatch(`/api post /x --data '{"a"`)).toBe(true);
    expect(runs).toEqual([]);
    expect(output()).toContain('Unknown command /hlep');
    expect(output()).toContain('Did you mean /help');
    expect(output()).toContain('Unclosed single quote');
  });

  it('explains a failed command and points at the next step', async () => {
    const { shell, output } = harness({
      results: [
        { code: 4, signal: null },
        { code: 1, signal: null },
        { code: null, signal: 'SIGINT' }
      ]
    });
    await shell.dispatch('/auth test');
    await shell.dispatch('/run --cert global-core');
    await shell.dispatch('/watch --cert global-core');
    const text = output();
    expect(text).toContain('exit 4 · auth · check your credentials with /doctor');
    expect(text).toContain('exit 1 · cert failed · see why with /diagnose');
    expect(text).toContain('stopped (SIGINT)');
  });

  it('stops on /exit and its aliases', async () => {
    for (const line of ['/exit', '/quit', '/q', 'exit']) {
      expect(await harness().shell.dispatch(line)).toBe(false);
    }
    expect(await harness().shell.dispatch('/shell')).toBe(true);
  });

  it('saves /theme and /banner to the settings file', async () => {
    const { shell, output } = harness();
    await shell.dispatch('/theme gp-light');
    await shell.dispatch('/banner compact');
    await shell.dispatch('/theme neon');
    expect(JSON.parse(readFileSync(path.join(dir, 'ui.json'), 'utf8'))).toEqual({ theme: 'gp-light', banner: 'compact' });
    expect(output()).toContain('Theme set to gp-light');
    expect(output()).toContain('Unknown theme neon');
  });

  it('lists every command in /help, grouped, without itself', async () => {
    const { shell, output } = harness();
    await shell.dispatch('/help');
    const text = output();
    for (const heading of ['Get started', 'Sandbox and API', 'Certification', 'Shell', 'Keys']) expect(text).toContain(heading);
    expect(text).toContain('/api get <path>');
    expect(text).toContain('/theme [name]');
    expect(text).not.toContain('/shell ');
  });
});

describe('shell screens', () => {
  it('greets with the environment, and warns loudly on production', async () => {
    const sandbox = harness();
    await sandbox.shell.refreshStatus();
    sandbox.shell.welcome();
    expect(sandbox.output()).toContain('[sandbox] app UJqP…GRV · from .env');
    expect(sandbox.output()).toContain('/quick-start');

    const production = harness({ status: { hasKey: true, source: 'environment', environment: 'production', appId: 'live…123' } });
    await production.shell.refreshStatus();
    production.shell.welcome();
    expect(production.output()).toContain('[PRODUCTION]');
    expect(production.output()).toContain('Production credentials.');

    const empty = harness({ status: { hasKey: false, source: 'none' } });
    await empty.shell.refreshStatus();
    empty.shell.welcome();
    expect(empty.output()).toContain('[no credentials]');
    expect(empty.output()).toContain('/sandbox create');
  });

  it('opens with the plain ASCII banner when it fits, and the one-line lockup when it does not', async () => {
    for (const level of [0, 3] as const) {
      configureUi({ level, unicode: true, env: { GP_CLI_CONFIG_DIR: dir } });
      const wide = harness({ columns: 100 });
      await wide.shell.refreshStatus();
      wide.shell.welcome();
      expect(wide.output()).toContain('|___/  DEVELOPER CLI');
      expect(wide.output()).not.toMatch(/^ g /m);

      const narrow = harness({ columns: 70 });
      await narrow.shell.refreshStatus();
      narrow.shell.welcome();
      expect(narrow.output()).not.toContain('DEVELOPER CLI');
      expect(narrow.output()).toMatch(/global ?payments/);

      const short = harness({ columns: 120, rows: 12 });
      await short.shell.refreshStatus();
      short.shell.welcome();
      expect(short.output()).not.toContain('DEVELOPER CLI');
    }
  });

  it('keeps the welcome and /help inside narrow terminals', async () => {
    const statuses: ShellStatus[] = [
      { hasKey: true, source: '.env', environment: 'sandbox', appId: 'UJqP…GRV', envFile: '.env' },
      { hasKey: false, source: 'environment', environment: 'sandbox', appId: 'UJqP…GRV' },
      { hasKey: true, source: 'environment', environment: 'production', appId: 'live…123' },
      { hasKey: false, source: 'none' },
      { hasKey: false, source: 'none', problem: 'globalpayments.config.json at /Users/someone/projects/a-very-long-folder-name/globalpayments.config.json is not valid JSON' }
    ];
    for (const columns of [30, 40, 50, 60, 77, 78, 80, 100]) {
      for (const status of statuses) {
        const { shell, output } = harness({ status, columns });
        await shell.refreshStatus();
        shell.welcome();
        await shell.dispatch('/help');
        for (const line of output().split('\n')) {
          expect(line.length, `${columns} columns, ${status.source}: ${line}`).toBeLessThanOrEqual(columns);
        }
      }
    }
    const { shell, output } = harness({ status: { hasKey: false, source: 'none' }, columns: 40 });
    await shell.refreshStatus();
    shell.welcome();
    await shell.dispatch('/help');
    const text = output().replace(/\s+/g, ' ');
    expect(text).toContain('No GP API credentials found in the environment, .env or project config.');
    expect(text).toContain('Connect a sandbox app with /sandbox create, or take the tour with /quick-start.');
    expect(text).toContain('/transactions testpay');
    expect(text).toContain('Commands run the same with or without the slash, and /help <command> shows its flags.');
  });

  it('runs every piped line and fails with the first failure, typos included', async () => {
    const { deps, output, runs } = harness({ results: [{ code: 0, signal: null }, { code: 6, signal: null }, { code: 4, signal: null }] });
    deps.input = Object.assign(Readable.from(['# setup\n/doctor\n\n/report\n/auth test\n/version\n']), { isTTY: false }) as unknown as ShellDependencies['input'];
    await expect(runShell(deps)).resolves.toBe(6);
    expect(runs).toHaveLength(3);
    const typo = harness();
    typo.deps.input = Object.assign(Readable.from(['/doctr\n/version\n']), { isTTY: false }) as unknown as ShellDependencies['input'];
    await expect(runShell(typo.deps)).resolves.toBe(2);
    expect(output()).toContain('❯ /doctor');
    expect(output()).toContain('❯ /report');
  });

  it('describes itself as JSON for agents', () => {
    const data = shellCatalog(buildCli());
    expect(data.interactive).toBe(false);
    expect(data.commands.map((c) => c.command)).toContain('/api get <path>');
    expect(data.builtins.map((b) => b.command)).toContain('/exit');
  });
});

describe('global flags', () => {
  it('lets --no-color and --color sit anywhere before --', () => {
    expect(stripGlobalFlags(['node', 'bin', 'doctor', '--no-color', '--json'])).toEqual(['node', 'bin', 'doctor', '--json']);
    expect(stripGlobalFlags(['node', 'bin', '--color', 'doctor', '--', '--no-color'])).toEqual(['node', 'bin', 'doctor', '--', '--no-color']);
  });
});

describe('completion', () => {
  const root = buildCli();

  it('offers one word at a time and never the shell built-ins', async () => {
    const first = await completeWords(root, ['']);
    expect(first).toContain('api');
    expect(first).toContain('doctor');
    expect(first).not.toContain('api get');
    expect(first).not.toContain('exit');
    expect(first).not.toContain('__complete');
    expect(new Set(first).size).toBe(first.length);
    expect(await completeWords(root, ['api', ''])).toEqual(['get', 'post']);
    expect((await completeWords(root, ['watch', '--cert', 'global-co']))[0]).toBe('global-core');
    expect(await completeWords(root, ['cases', 'show', 'global-core:'])).toContain('global-core:basic-sale-approved');
  });

  it('formats candidates for each shell', async () => {
    const zsh = await completeWords(root, ['cases', 'show', 'global-core:basic'], 'zsh');
    expect(zsh[0]).toBe('global-core\\:basic-sale-approved');
    const fish = await completeWords(root, ['doc'], 'fish');
    expect(fish[0]).toMatch(/^doctor\t/);
  });

  for (const shell of SHELLS) {
    it(`prints a ${shell} script the shell can parse`, () => {
      const script = completionScript(shell);
      expect(script).toContain('globalpayments __complete');
      const check = spawnSync(shell, ['-n'], { input: script, encoding: 'utf8' });
      if (check.error && (check.error as NodeJS.ErrnoException).code === 'ENOENT') return;
      expect(check.status, check.stderr).toBe(0);
    });
  }
});

describe('spinner', () => {
  function fakeStream(isTTY: boolean) {
    const writes: string[] = [];
    return { writes, stream: { isTTY, columns: 80, write: (chunk: string) => writes.push(chunk) } as unknown as NodeJS.WriteStream };
  }

  it('stays silent off a terminal, in JSON mode and in CI', async () => {
    for (const [isTTY, silent, env] of [
      [false, false, {}],
      [true, true, {}],
      [true, false, { CI: 'true' }]
    ] as const) {
      const { writes, stream } = fakeStream(isTTY);
      await expect(withSpinner('x', async () => 42, { stream, silent, env, delayMs: 0 })).resolves.toBe(42);
      expect(writes).toEqual([]);
    }
  });

  it('draws, then clears its line and restores the cursor, even when the task fails', async () => {
    const { writes, stream } = fakeStream(true);
    await expect(
      withSpinner(
        'GET /transactions',
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('boom')), 30)),
        { stream, env: {}, delayMs: 0 }
      )
    ).rejects.toThrow('boom');
    const text = writes.join('');
    expect(text).toContain('GET /transactions');
    expect(text).toContain('\x1B[?25l');
    expect(text.endsWith('\r\x1B[2K\x1B[?25h')).toBe(true);
  });

  it('never flickers for a fast task', async () => {
    const { writes, stream } = fakeStream(true);
    await withSpinner('fast', async () => 1, { stream, env: {}, delayMs: 50 });
    expect(writes).toEqual([]);
  });
});
