import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { Command } from 'commander';
import { EXIT_CODES, exitCodeName } from '../contract/exit-codes.js';
import { stringWidth, truncate, wrapText } from '../ui/ansi.js';
import { terminalColumns, terminalRows } from '../ui/capabilities.js';
import { DOCS_URL, environmentBadge, lockup, renderBanner, type BannerMode } from '../ui/brand.js';
import { groupedLeaves, summaryFor } from '../ui/help.js';
import { activeTheme, reloadUi, statusMark, sym, t, uiSettings } from '../ui/index.js';
import { columns, flow, keyValues, styledWords } from '../ui/layout.js';
import { renderThemePreview } from '../ui/preview.js';
import { configDir, saveSettings } from '../ui/settings.js';
import { isThemeName } from '../ui/theme.js';
import { BUILTINS, Catalog } from './catalog.js';
import { LineEditor, type EditorInput, type EditorOutput } from './editor.js';
import { History } from './history.js';
import { loadCompletionData } from './completion-data.js';
import { readShellStatus, type ShellStatus } from './status.js';
import { tokenize } from './tokenize.js';

/**
 * The interactive shell: `globalpayments` with no arguments in a terminal.
 *
 * Every CLI command is available as a slash command with a live palette, Tab
 * completion for commands, flags and values (pack ids, case addresses, files),
 * history with inline suggestions, and an environment badge in the prompt so
 * nobody forgets whether they are pointed at sandbox or production.
 *
 * Commands run as child processes of the same CLI with the terminal handed over,
 * so each one behaves exactly as it does when typed in a normal shell (prompts,
 * the watch UI, Ctrl+C), and nothing one command does can leak into the next.
 */

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ShellDependencies {
  program: Command;
  version: string;
  input: EditorInput & { isTTY?: boolean };
  output: EditorOutput & { isTTY?: boolean };
  run?: (args: string[]) => Promise<RunResult>;
  status?: () => Promise<ShellStatus>;
  /** Background lookups for completion. */
  completionData?: () => Promise<{ packIds: string[]; caseAddresses: string[] }>;
  env?: NodeJS.ProcessEnv;
  historyFile?: string | null;
  now?: () => number;
  /** Render synchronously, for tests. */
  synchronous?: boolean;
}

const EXIT_HINTS: Partial<Record<number, string>> = {
  [EXIT_CODES.CERT_FAILED]: 'see why with /diagnose',
  [EXIT_CODES.USAGE]: 'check the flags with /help <command>',
  [EXIT_CODES.CONFIG]: 'check your setup with /doctor',
  [EXIT_CODES.AUTH]: 'check your credentials with /doctor',
  [EXIT_CODES.NETWORK]: 'usually transient; /doctor checks connectivity',
  [EXIT_CODES.NOT_FOUND]: 'list what exists with /packs list or /cases list',
  [EXIT_CODES.INTERNAL]: 'this is a bug; please report it with the output above',
  [EXIT_CODES.API_REJECTED]: 'recent rejections are in /logs tail --once',
  [EXIT_CODES.WEBHOOK_DELIVERY]: 'is your receiver running on the --forward-to URL?',
  [EXIT_CODES.SETUP_FAILED]: 'the output above says which step failed'
};

/** Spawn this CLI again with the terminal handed over. */
export function runSelf(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  const entry = process.argv[1];
  return new Promise((resolve, reject) => {
    if (!entry) {
      reject(new Error('Cannot locate the CLI entry point.'));
      return;
    }
    const child = spawn(process.execPath, [...process.execArgv, entry, ...args], {
      stdio: 'inherit',
      env: { ...env, GP_CLI_SHELL: '1' }
    });
    // Ctrl+C belongs to the command while it runs: the terminal sends SIGINT to
    // the whole foreground group, and the shell must survive it.
    const ignore = (): void => {};
    const forward = (signal: NodeJS.Signals) => (): void => {
      child.kill(signal);
    };
    const onTerm = forward('SIGTERM');
    const onHup = forward('SIGHUP');
    process.on('SIGINT', ignore);
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    const cleanup = (): void => {
      process.off('SIGINT', ignore);
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
}

/**
 * Stop like any other foreground program on Ctrl+Z and pick up again on `fg`.
 * Raw mode swallows the key, so the shell sends itself SIGTSTP. A timer keeps the
 * event loop alive while stopped; without it Node finds nothing left to wait for
 * on resume and exits.
 */
function suspendSelf(): Promise<void> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 1 << 30);
    process.once('SIGCONT', () => {
      clearInterval(keepAlive);
      resolve();
    });
    process.kill(process.pid, 'SIGTSTP');
  });
}

export class Shell {
  private readonly catalog: Catalog;
  private readonly history: History;
  private readonly editor: LineEditor;
  private status: ShellStatus = { hasKey: false, source: 'none' };
  private packIds: string[] = [];
  private caseAddresses: string[] = [];
  private lastExit = 0;
  private stopped = false;
  /** Script mode keeps nothing in history. */
  private recordHistory = true;
  private terminating: NodeJS.Signals | undefined;
  /** The terminal settings at start, put back after each command (POSIX). */
  private savedStty: string | undefined;

  constructor(private readonly deps: ShellDependencies) {
    this.catalog = new Catalog(deps.program, {
      packIds: () => this.packIds,
      caseAddresses: () => this.caseAddresses
    });
    const historyFile = deps.historyFile === undefined ? path.join(configDir(deps.env), 'history') : deps.historyFile;
    this.history = new History(historyFile ?? undefined);
    this.editor = new LineEditor({
      input: deps.input,
      output: deps.output,
      prompt: () => this.prompt(),
      suggest: (line, cursor) => this.catalog.suggest(line, cursor),
      history: this.history,
      hints: () => uiSettings().settings.hints === 'on',
      synchronous: deps.synchronous
    });
  }

  private write(text = ''): void {
    this.deps.output.write(`${text}\n`);
  }

  private columns(): number {
    return terminalColumns(this.deps.output, this.deps.env);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private prompt(): string {
    const kind = this.status.source === 'none' ? 'none' : this.status.environment === 'production' ? 'production' : 'sandbox';
    return `${environmentBadge(kind)} ${t.accent(sym().pointer)} `;
  }

  async refreshStatus(): Promise<void> {
    try {
      this.status = await (this.deps.status ?? (() => readShellStatus()))();
    } catch {
      this.status = { hasKey: false, source: 'none' };
    }
  }

  private loadCompletionData(): void {
    const loader = this.deps.completionData ?? loadCompletionData;
    loader()
      .then((data) => {
        this.packIds = data.packIds;
        this.caseAddresses = data.caseAddresses;
      })
      .catch(() => {
        // Completion data is a convenience; the shell works without it.
      });
  }

  // ------------------------------------------------------------------ screens

  welcome(): void {
    const width = this.columns();
    const mode = uiSettings().settings.banner as BannerMode;
    const banner = renderBanner({ mode, columns: width, rows: terminalRows(this.deps.output, this.deps.env), indent: 1 });
    const s = sym();
    this.write();
    for (const line of banner) this.write(line);
    if (banner.length > 0) this.write();
    const title = `${t.heading('Global Payments CLI')} ${t.muted(this.deps.version)}`;
    const tagline = 'certify, test and debug GP API integrations';
    if (stringWidth(title) + stringWidth(tagline) + 5 <= width) {
      this.write(` ${title} ${t.muted(`${s.dot} ${tagline}`)}`);
    } else {
      this.write(` ${title}`);
      for (const line of wrapText(tagline, width - 2)) this.write(` ${t.muted(line)}`);
    }
    this.write();
    for (const tokens of this.statusLines()) for (const line of flow(tokens, width - 2)) this.write(` ${line}`);
    this.write();
    const starters: Array<[string, string]> = [
      ['/quick-start', 'guided tour'],
      ['/doctor', 'check your setup'],
      ['/help', 'every command']
    ];
    const starterLine = starters.map(([command, text]) => `${t.command(command)} ${t.muted(text)}`).join(t.muted('   '));
    if (stringWidth(starterLine) + 1 <= width) {
      this.write(` ${starterLine}`);
    } else {
      for (const [command, text] of starters) this.write(` ${t.command(command.padEnd(13))}${t.muted(text)}`);
    }
    // Wrap between tips, never inside one.
    const tips = ['Type / for commands', 'Tab completes', `${s.up} history`, 'Ctrl+C clears', '/exit leaves'];
    let line = '';
    for (const tip of tips) {
      const next = line ? `${line} ${s.dot} ${tip}` : tip;
      if (line && stringWidth(next) > width - 2) {
        this.write(` ${t.muted(line)}`);
        line = tip;
      } else {
        line = next;
      }
    }
    if (line) this.write(` ${t.muted(line)}`);
    for (const problem of uiSettings().problems) this.write(` ${statusMark('warn')} ${t.muted(problem)}`);
    this.write();
  }

  /** The credential status under the banner, as token lists so they wrap cleanly. */
  private statusLines(): string[][] {
    const status = this.status;
    const s = sym();
    const muted = (text: string): string[] => styledWords(text, t.muted);
    if (status.problem) {
      return [
        [environmentBadge('none'), ...styledWords('Configuration problem:', t.warning), ...styledWords(status.problem)],
        [...muted('Run'), t.command('/doctor'), ...muted('for the details.')]
      ];
    }
    if (status.source === 'none') {
      return [
        [environmentBadge('none'), ...muted('No GP API credentials found in the environment, .env or project config.')],
        [...muted('Connect a sandbox app with'), `${t.command('/sandbox create')}${t.muted(',')}`, ...muted('or take the tour with'), `${t.command('/quick-start')}${t.muted('.')}`]
      ];
    }
    const kind = status.environment === 'production' ? 'production' : 'sandbox';
    const from = status.source === 'config' ? (status.configPath ?? 'config') : status.source === '.env' ? '.env' : 'environment';
    const lines = [
      [
        environmentBadge(kind),
        t.muted('app'),
        status.appId ?? '?',
        ...muted(`${s.dot} from`),
        t.muted(from),
        ...(status.hasKey ? [] : styledWords(`${s.dot} app key missing`, t.warning))
      ]
    ];
    if (kind === 'production') {
      lines.push([statusMark('warn'), ...styledWords('Production credentials.', t.warning), ...muted('Reads return live data; api post and testpay refuse to run.')]);
    }
    return lines;
  }

  /**
   * Name and description pairs for /help: side by side when the description
   * still gets a readable column, otherwise the name on its own line with the
   * description wrapped under it, so nothing runs off a narrow terminal.
   */
  private entries(rows: Array<[string, string]>, nameWidth: number): string[] {
    const width = this.columns();
    const indent = 3;
    const gap = 2;
    if (width - indent - nameWidth - gap >= 24) {
      const pad = (text: string): string => text + ' '.repeat(Math.max(0, nameWidth - stringWidth(text)));
      return columns(rows.map(([name, text]) => [t.accent(pad(name)), text]), { width, gap, indent, wrap: true });
    }
    const lines: string[] = [];
    for (const [name, text] of rows) {
      lines.push(`${' '.repeat(indent)}${t.accent(truncate(name, width - indent))}`);
      for (const line of wrapText(text, width - indent - 2)) lines.push(`${' '.repeat(indent + 2)}${line}`);
    }
    return lines;
  }

  private renderHelp(): void {
    const width = this.columns();
    const groups = groupedLeaves(this.deps.program).map((group) => ({
      ...group,
      leaves: group.leaves.filter((leaf) => leaf.path !== 'shell')
    }));
    const termWidth = Math.min(
      30,
      Math.max(...groups.flatMap((g) => g.leaves.map((leaf) => stringWidth(leaf.term) + 1)), ...BUILTINS.map((b) => b.name.length + (b.args ? b.args.length + 2 : 1)))
    );
    this.write();
    for (const group of groups) {
      this.write(` ${t.heading(group.title)}`);
      for (const line of this.entries(group.leaves.map((leaf) => [`/${leaf.term}`, summaryFor(leaf.path, leaf.description)]), termWidth)) {
        this.write(line);
      }
      this.write();
    }
    this.write(` ${t.heading('Shell')}`);
    for (const line of this.entries(BUILTINS.map((b) => [`/${b.name}${b.args ? ` ${b.args}` : ''}`, b.description]), termWidth)) {
      this.write(line);
    }
    this.write();
    const s = sym();
    this.write(` ${t.heading('Keys')}`);
    for (const line of this.entries(
      [
        ['Tab', 'Complete commands, flags, pack ids, case addresses and files'],
        [s.upDown, 'Move through the palette, or through history (filtered by what you typed)'],
        [`${s.arrow} or End`, 'Accept the grey suggestion'],
        ['Esc', 'Close the palette'],
        ['Ctrl+C', 'Clear the line; twice on an empty line to leave'],
        ['Ctrl+L', 'Clear the screen'],
        ['Ctrl+A Ctrl+E', 'Start or end of line'],
        ['Ctrl+W Ctrl+U', 'Delete a word, or the whole line before the cursor'],
        ['Ctrl+D', 'Leave the shell']
      ],
      termWidth
    )) {
      this.write(line);
    }
    this.write();
    for (const line of flow([...styledWords('Commands run the same with or without the slash, and', t.muted), t.command('/help <command>'), ...styledWords('shows its flags.', t.muted)], this.columns() - 2)) {
      this.write(` ${line}`);
    }
    this.write();
  }

  private renderEnv(): void {
    const status = this.status;
    const kind = status.source === 'none' ? 'none' : status.environment === 'production' ? 'production' : 'sandbox';
    this.write();
    this.write(` ${environmentBadge(kind)}`);
    const rows: Array<[string, string]> = [
      ['Environment', status.environment ?? 'sandbox'],
      ['App ID', status.appId ?? t.muted('not set')],
      ['App key', status.hasKey ? 'set (never shown)' : t.muted('not set')],
      ['Credentials from', status.source === 'none' ? t.muted('nowhere yet') : status.source],
      ['Project config', status.configPath ?? t.muted('none, configured from the environment')],
      ['Env file', status.envFile ?? t.muted('no .env in this directory')],
      ['Working directory', process.cwd()],
      ['Theme', activeTheme().name],
      ['Settings', path.join(configDir(this.deps.env), 'ui.json')]
    ];
    for (const line of keyValues(rows, { width: this.columns(), indent: 3, gap: 3 })) this.write(line);
    if (status.problem) this.write(`   ${statusMark('warn')} ${status.problem}`);
    this.write();
    this.write(` ${t.muted('Change it by editing .env, setting GP_API_* variables, or')} ${t.command('/sandbox create --replace')}${t.muted('.')}`);
    this.write();
  }

  private renderDocs(): void {
    this.write();
    for (const line of keyValues(
      [
        ['Developer portal', t.link(DOCS_URL)],
        ['API reference', t.link(`${DOCS_URL}/api/references-overview`)],
        ['Sandbox test cards', t.link(`${DOCS_URL}/resources/test-cards`)],
        ['CLI source', t.link('https://github.com/globalpayments/globalpayments-cli')]
      ],
      { width: this.columns(), indent: 3, gap: 3 }
    )) {
      this.write(line);
    }
    this.write();
  }

  private renderHistory(): void {
    const entries = this.history.all().slice(-20);
    this.write();
    if (entries.length === 0) {
      this.write(` ${t.muted('Nothing yet. Commands you run show up here and under the up arrow.')}`);
    } else {
      const start = this.history.all().length - entries.length + 1;
      entries.forEach((entry, index) => this.write(` ${t.muted(String(start + index).padStart(4))}  ${entry}`));
    }
    this.write();
  }

  // ------------------------------------------------------------------ dispatch

  /** Handle one line. Returns false when the shell should stop. */
  async dispatch(raw: string): Promise<boolean> {
    const trimmed = raw.trim();
    if (!trimmed) return true;

    let body = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
    // A pasted "globalpayments doctor" runs as "doctor".
    body = body.replace(/^(?:npx\s+(?:@globalpayments\/cli|globalpayments)|globalpayments)\s+/, '');
    const { args, error } = tokenize(body);
    if (error) {
      this.write(`${statusMark('fail')} ${error}`);
      this.lastExit = EXIT_CODES.USAGE;
      return true;
    }
    if (args.length === 0) {
      this.renderHelp();
      return true;
    }

    const [first, ...rest] = args;
    const builtin = this.catalog.builtin(first!);
    if (builtin && this.catalog.resolve([first!]).consumed === 0) {
      this.remember(trimmed);
      this.lastExit = 0;
      return this.runBuiltin(builtin.name, rest);
    }

    const { command, consumed } = this.catalog.resolve(args);
    if (consumed === 0) {
      const suggestions = this.catalog.didYouMean(first!);
      this.write(`${statusMark('fail')} Unknown command ${t.strong(`/${first}`)}`);
      if (suggestions.length > 0) {
        this.write(`  ${t.muted('Did you mean')} ${suggestions.map((name) => t.command(`/${name}`)).join(t.muted(', '))}${t.muted('?')}`);
      } else {
        this.write(`  ${t.muted('Type')} ${t.command('/')} ${t.muted('to browse commands, or')} ${t.command('/help')} ${t.muted('to list them.')}`);
      }
      // Not remembered: an unknown line is often something pasted by mistake, like a key.
      this.lastExit = EXIT_CODES.USAGE;
      return true;
    }
    this.remember(trimmed);
    if (command.name() === 'shell' && consumed === 1) {
      this.write(`${statusMark('info')} ${t.muted("You're already in the shell.")}`);
      return true;
    }
    // A group on its own (/api, /packs) shows what is inside it.
    const runArgs = command.commands.length > 0 && consumed === args.length ? [...args, '--help'] : args;
    await this.runCommand(runArgs);
    return true;
  }

  private remember(line: string): void {
    if (this.recordHistory) this.history.add(line);
  }

  private async runCommand(args: string[]): Promise<void> {
    const started = this.now();
    let result: RunResult;
    try {
      result = await (this.deps.run ?? ((a) => runSelf(a, this.deps.env)))(args);
    } catch (error) {
      this.write(`${statusMark('fail')} Could not start the command: ${error instanceof Error ? error.message : String(error)}`);
      this.lastExit = EXIT_CODES.INTERNAL;
      return;
    }
    this.restoreTerminal();
    const elapsed = this.now() - started;
    const s = sym();
    if (result.signal) {
      this.write(t.muted(`${s.skip} stopped (${result.signal})`));
      this.lastExit = 130;
    } else if (result.code === 0) {
      this.lastExit = 0;
      if (elapsed >= 1500) this.write(`${statusMark('pass')} ${t.muted(`done in ${(elapsed / 1000).toFixed(1)}s`)}`);
    } else {
      const code = result.code ?? 1;
      this.lastExit = code;
      const hint = EXIT_HINTS[code];
      const name = exitCodeName(code).toLowerCase().replace(/_/g, ' ');
      this.write(
        `${statusMark(code === EXIT_CODES.CERT_FAILED ? 'warn' : 'fail')} ${t.muted(`exit ${code} ${s.dot} ${name}`)}${hint ? t.muted(` ${s.dot} ${hint}`) : ''}`
      );
    }
    this.write();
    // A command may have changed credentials (/sandbox create, /init).
    await this.refreshStatus();
  }

  private async runBuiltin(name: string, args: string[]): Promise<boolean> {
    switch (name) {
      case 'exit':
        return false;
      case 'help': {
        if (args.length === 0) {
          this.renderHelp();
          return true;
        }
        const builtin = this.catalog.builtin(args[0]!);
        if (builtin && this.catalog.resolve([args[0]!]).consumed === 0) {
          this.write(`  ${t.accent(`/${builtin.name}${builtin.args ? ` ${builtin.args}` : ''}`)}  ${builtin.description}`);
          return true;
        }
        const { consumed } = this.catalog.resolve(args);
        if (consumed === 0) {
          return this.dispatch(`/${args.join(' ')}`);
        }
        await this.runCommand([...args.slice(0, consumed), '--help']);
        return true;
      }
      case 'theme': {
        const value = args[0];
        if (!value) {
          this.write();
          for (const line of renderThemePreview(activeTheme().name)) this.write(` ${line}`);
          this.write(` ${t.muted('Switch with')} ${t.command('/theme <name>')}${t.muted('; auto follows the terminal background when it is advertised.')}`);
          this.write();
          return true;
        }
        if (value !== 'auto' && !isThemeName(value)) {
          this.write(`${statusMark('fail')} Unknown theme ${t.strong(value)}. ${t.muted('Choose auto, gp, gp-light, classic or mono.')}`);
          this.lastExit = EXIT_CODES.USAGE;
          return true;
        }
        this.save({ theme: value });
        this.write(`${statusMark('pass')} Theme set to ${t.accent(value === 'auto' ? `auto (${activeTheme().name})` : value)}.`);
        return true;
      }
      case 'banner': {
        const value = args[0];
        if (!value) {
          this.write(`  ${t.muted('Banner is')} ${uiSettings().settings.banner}${t.muted('. Choose full, compact or off.')}`);
          return true;
        }
        if (!['full', 'compact', 'off'].includes(value)) {
          this.write(`${statusMark('fail')} Unknown banner ${t.strong(value)}. ${t.muted('Choose full, compact or off.')}`);
          this.lastExit = EXIT_CODES.USAGE;
          return true;
        }
        this.save({ banner: value });
        this.write(`${statusMark('pass')} Banner set to ${t.accent(value)}.`);
        if (value !== 'off') {
          this.write();
          for (const line of renderBanner({ mode: value as BannerMode, columns: this.columns(), rows: terminalRows(this.deps.output, this.deps.env), indent: 1 })) {
            this.write(line);
          }
          this.write();
        }
        return true;
      }
      case 'env':
        await this.refreshStatus();
        this.renderEnv();
        return true;
      case 'history':
        this.renderHistory();
        return true;
      case 'docs':
        this.renderDocs();
        return true;
      case 'clear':
        this.deps.output.write('\x1B[2J\x1B[3J\x1B[H');
        this.write(` ${lockup()}  ${t.muted(this.deps.version)}`);
        this.write();
        return true;
      case 'version':
        this.write(this.deps.version);
        return true;
      default:
        return true;
    }
  }

  private save(changes: Record<string, string>): void {
    try {
      saveSettings(changes, this.deps.env);
    } catch (error) {
      this.write(`${statusMark('warn')} ${t.muted(`Could not save settings: ${error instanceof Error ? error.message : String(error)}`)}`);
    }
    reloadUi();
  }

  // ------------------------------------------------------------------ loops

  private saveTerminal(): void {
    if (process.platform === 'win32' || !this.deps.input.isTTY || this.deps.run) return;
    const result = spawnSync('stty', ['-g'], { stdio: ['inherit', 'pipe', 'ignore'], encoding: 'utf8' });
    const saved = result.status === 0 ? result.stdout.trim() : '';
    if (saved) this.savedStty = saved;
  }

  /** A command killed mid-prompt can leave the terminal raw; put the settings from the start back. */
  private restoreTerminal(): void {
    if (!this.savedStty) return;
    spawnSync('stty', [this.savedStty], { stdio: ['inherit', 'ignore', 'ignore'] });
  }

  /**
   * Signals for the shell's whole life. Ctrl+C between commands (while a command
   * is finishing, or the status is being read) must not kill the shell, and
   * SIGTERM or SIGHUP end it cleanly: the running command gets the signal too,
   * the terminal is given back, and the shell exits once the command is gone.
   */
  private installSignals(): () => void {
    const ignore = (): void => {};
    const terminate = (signal: NodeJS.Signals) => (): void => {
      this.terminating = signal;
      this.stopped = true;
      this.editor.cancel();
    };
    const onTerm = terminate('SIGTERM');
    const onHup = terminate('SIGHUP');
    process.on('SIGINT', ignore);
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    return () => {
      process.off('SIGINT', ignore);
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
    };
  }

  /** The interactive loop. Resolves with the exit code of the shell itself. */
  async start(): Promise<number> {
    this.saveTerminal();
    const removeSignals = this.installSignals();
    await this.refreshStatus();
    this.loadCompletionData();
    this.welcome();
    let lastInterrupt = -Infinity;
    let notice: string | undefined;
    let resumeLine: string | undefined;
    try {
      while (!this.stopped) {
        const result = await this.editor.read({ notice, line: resumeLine });
        notice = undefined;
        resumeLine = undefined;
        if (result.type === 'eof') break;
        if (result.type === 'interrupt') {
          if (this.now() - lastInterrupt < 2000) break;
          lastInterrupt = this.now();
          notice = 'Press Ctrl+C again to leave, or type /exit.';
          continue;
        }
        if (result.type === 'suspend') {
          await suspendSelf();
          resumeLine = result.line;
          continue;
        }
        lastInterrupt = -Infinity;
        const keepGoing = await this.dispatch(result.line);
        if (!keepGoing) break;
      }
    } finally {
      this.editor.detach();
      this.restoreTerminal();
      this.history.compact();
      removeSignals();
    }
    if (this.terminating) return this.terminating === 'SIGHUP' ? 129 : 143;
    this.write(t.muted(' Bye.'));
    return 0;
  }

  /**
   * Non-interactive: run each line of piped input as a command. Every line runs,
   * and the exit code is the first failure's, so a typo or a failing command
   * fails the script the way it would in CI.
   */
  async script(lines: AsyncIterable<string>): Promise<number> {
    this.recordHistory = false;
    await this.refreshStatus();
    let firstFailure = 0;
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      this.write(`${t.accent(sym().pointer)} ${trimmed}`);
      this.lastExit = 0;
      const keepGoing = await this.dispatch(trimmed);
      if (this.lastExit !== 0 && firstFailure === 0) firstFailure = this.lastExit;
      if (!keepGoing) break;
    }
    return firstFailure;
  }

  stop(): void {
    this.stopped = true;
  }
}

export async function runShell(deps: ShellDependencies): Promise<number> {
  const shell = new Shell(deps);
  if (deps.input.isTTY && deps.output.isTTY) {
    return shell.start();
  }
  const reader = createInterface({ input: deps.input as NodeJS.ReadableStream, crlfDelay: Infinity, terminal: false });
  return shell.script(reader);
}

