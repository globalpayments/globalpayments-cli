import type { Command, Help } from 'commander';
import { padEnd, stringWidth } from './ansi.js';
import { terminalColumns } from './capabilities.js';
import { DOCS_URL, lockup } from './brand.js';
import { columns } from './layout.js';
import { sym, t } from './index.js';
import { humanCommand } from './text.js';

/**
 * Help that reads like a guide rather than a dump of commander's defaults.
 *
 * The root lists every runnable command (leaves, not groups, so `api get <path>`
 * shows up as itself) under task headings, in the order a newcomer needs them.
 * Command help adds worked examples. The same grouping feeds the shell's /help,
 * so the two can never disagree.
 */
export interface CommandGroup {
  title: string;
  commands: string[];
}

export const COMMAND_GROUPS: CommandGroup[] = [
  { title: 'Get started', commands: ['quick-start', 'shell', 'doctor', 'init', 'sandbox create'] },
  {
    title: 'Sandbox and API',
    commands: ['api get', 'api post', 'transactions get', 'transactions testpay', 'auth test', 'logs tail', 'listen', 'trigger']
  },
  {
    title: 'Certification',
    commands: ['packs list', 'packs show', 'cases list', 'cases show', 'run', 'watch', 'report', 'diagnose']
  },
  { title: 'AI agents and automation', commands: ['agent setup', 'explain', 'completion'] },
  { title: 'Personalise', commands: ['ui show', 'ui set', 'ui reset', 'ui themes'] }
];

/**
 * One-line summaries for listings (root help, the shell palette, /help). The full
 * descriptions stay on each command for its own --help and for `explain`.
 */
export const SUMMARIES: Record<string, string> = {
  'quick-start': 'Guided sandbox tour of the CLI',
  shell: 'Interactive shell with slash commands',
  doctor: 'Check config, credentials and API reachability',
  init: 'Scaffold .env.example and a config file',
  'sandbox create': 'Connect an existing sandbox app',
  'api get': 'GET any GP API resource',
  'api post': 'POST JSON to the GP API (sandbox only)',
  'transactions get': 'Look up one transaction',
  'transactions testpay': 'Start a sandbox TestPay sale',
  'auth test': 'Exchange credentials for an access token',
  'logs tail': 'Watch rejected API requests',
  listen: 'Forward local webhooks to your app',
  trigger: 'Send a signed test webhook',
  'packs list': 'List certification packs',
  'packs show': 'Show a pack and its cases',
  'cases list': 'List certification cases',
  'cases show': 'Show one case in full',
  run: 'Evaluate cases once (CI friendly)',
  watch: 'Watch cases live until they pass',
  report: 'Re-read the last saved result',
  diagnose: 'Explain failing cases and how to fix them',
  'agent setup': 'Set up the MCP server and SDK skills for AI agents',
  explain: 'Machine-readable CLI contract',
  completion: 'Tab completion for bash, zsh and fish',
  'ui show': 'Show your terminal settings',
  'ui set': 'Change a terminal setting',
  'ui reset': 'Reset terminal settings',
  'ui themes': 'Preview the colour themes'
};

/** The listing line for a command: its summary, or the first sentence of its description. */
export function summaryFor(path: string, description: string): string {
  return SUMMARIES[path] ?? shortDescription(description);
}

export const EXAMPLES: Record<string, string[]> = {
  '': ['globalpayments', 'globalpayments doctor', 'globalpayments api get /transactions?page_size=5', 'globalpayments watch --cert global-core'],
  'quick-start': ['globalpayments quick-start'],
  shell: ['globalpayments shell', 'globalpayments'],
  doctor: ['globalpayments doctor', 'globalpayments doctor --env-file .env.sandbox --json'],
  init: ['globalpayments init', 'globalpayments init --with-config'],
  'sandbox create': ['globalpayments sandbox create', 'globalpayments sandbox create --replace'],
  'api get': ['globalpayments api get /transactions?page_size=5', 'globalpayments api get /transactions --json'],
  'api post': ['globalpayments api post /transactions --data-file request.json --json'],
  'transactions get': ['globalpayments transactions get TRN_abc123'],
  'transactions testpay': [
    'globalpayments transactions testpay --status-url https://YOUR-HOST/status --return-url https://YOUR-HOST/return'
  ],
  'auth test': ['globalpayments auth test', 'globalpayments auth test --json'],
  'logs tail': ['globalpayments logs tail --status 4xx', 'globalpayments logs tail --status 5xx --once --json'],
  listen: ['globalpayments listen --forward-to http://localhost:3000/webhooks --verify-signature'],
  trigger: ['globalpayments trigger transaction.captured', 'globalpayments trigger transaction.declined --port 4242'],
  'packs list': ['globalpayments packs list'],
  'packs show': ['globalpayments packs show global-ecommerce'],
  'cases list': ['globalpayments cases list --cert global-core', 'globalpayments cases list --cert global-ecommerce --required-only'],
  'cases show': ['globalpayments cases show global-core:basic-sale-approved'],
  run: ['globalpayments run --cert global-core', 'globalpayments run --cert global-ecommerce --timeout 30s --json'],
  watch: ['globalpayments watch --cert global-core', 'globalpayments watch --cert global-ecommerce --no-interactive'],
  report: ['globalpayments report', 'globalpayments report --json'],
  diagnose: ['globalpayments diagnose', 'globalpayments diagnose global-ecommerce:3ds-challenge'],
  'agent setup': ['globalpayments agent setup', 'globalpayments agent setup --editor vscode --editor cursor'],
  explain: ['globalpayments explain --json'],
  completion: [
    'globalpayments completion zsh > ~/.zfunc/_globalpayments',
    'eval "$(globalpayments completion bash)"',
    'globalpayments completion fish > ~/.config/fish/completions/globalpayments.fish'
  ],
  'ui show': ['globalpayments ui show'],
  'ui set': ['globalpayments ui set theme gp-light', 'globalpayments ui set banner compact', 'globalpayments ui set icons ascii'],
  'ui reset': ['globalpayments ui reset', 'globalpayments ui reset theme'],
  'ui themes': ['globalpayments ui themes']
};

/** Space-separated command path below the root, e.g. "api get". */
export function commandPath(command: Command): string {
  const parts: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    parts.unshift(current.name());
  }
  return parts.join(' ');
}

export interface LeafCommand {
  path: string;
  command: Command;
  /** Path plus argument placeholders, e.g. "api get <path>". */
  term: string;
  description: string;
}

function argumentPlaceholders(command: Command): string {
  return command.registeredArguments
    .map((argument) => {
      const name = argument.name() + (argument.variadic ? '...' : '');
      return argument.required ? `<${name}>` : `[${name}]`;
    })
    .join(' ');
}

/** Every runnable command, depth first, in registration order. */
export function leafCommands(root: Command): LeafCommand[] {
  const leaves: LeafCommand[] = [];
  const visit = (command: Command): void => {
    const children = command.commands.filter((child) => !(child as Command & { _hidden?: boolean })._hidden);
    if (children.length === 0 && command.parent) {
      const path = commandPath(command);
      const args = argumentPlaceholders(command);
      leaves.push({ path, command, term: args ? `${path} ${args}` : path, description: command.description() });
      return;
    }
    for (const child of children) visit(child);
  };
  visit(root);
  return leaves;
}

/** Leaves sorted into COMMAND_GROUPS; anything unlisted lands in "More". */
export function groupedLeaves(root: Command): Array<{ title: string; leaves: LeafCommand[] }> {
  const leaves = leafCommands(root);
  const byPath = new Map(leaves.map((leaf) => [leaf.path, leaf]));
  const placed = new Set<string>();
  const groups = COMMAND_GROUPS.map((group) => ({
    title: group.title,
    leaves: group.commands
      .map((path) => byPath.get(path))
      .filter((leaf): leaf is LeafCommand => {
        if (leaf) placed.add(leaf.path);
        return Boolean(leaf);
      })
  }));
  const rest = leaves.filter((leaf) => !placed.has(leaf.path));
  if (rest.length > 0) groups.push({ title: 'More', leaves: rest });
  return groups.filter((group) => group.leaves.length > 0);
}

/** Commander's description, cut at the first sentence for one-line listings. */
export function shortDescription(text: string): string {
  const firstSentence = text.split(/(?<=\.)\s/)[0] ?? text;
  return firstSentence.replace(/\.$/, '');
}

function exampleLines(path: string): string[] {
  const examples = EXAMPLES[path];
  if (!examples || examples.length === 0) return [];
  return ['', t.heading('Examples'), ...examples.map((example) => `  ${t.muted('$')} ${t.command(example)}`)];
}

function width(): number {
  return Math.min(terminalColumns(), 120);
}

function formatRootHelp(program: Command): string {
  const lines: string[] = [];
  const total = width();
  lines.push('');
  lines.push(`${lockup()}  ${t.muted(`developer CLI ${program.version() ?? ''}`.trim())}`);
  lines.push('');
  lines.push(`Certify, test and debug Global Payments integrations from your terminal.`);
  lines.push('');
  const groups = groupedLeaves(program);
  // One term width for every block, so all the descriptions line up down the page.
  const termWidth = Math.min(30, Math.max(14, ...groups.flatMap((group) => group.leaves.map((leaf) => stringWidth(leaf.term)))));
  lines.push(t.heading('Usage'));
  lines.push(`  ${t.muted('$')} ${t.command('globalpayments')} ${t.accent('<command>')} ${t.muted('[options]')}`);
  lines.push(`  ${padEnd(`${t.muted('$')} ${t.command('globalpayments')}`, termWidth)}   ${t.muted('starts the interactive shell')}`);
  for (const group of groups) {
    lines.push('');
    lines.push(t.heading(group.title));
    lines.push(
      ...columns(
        group.leaves.map((leaf) => [padEnd(t.accent(leaf.term), termWidth), summaryFor(leaf.path, leaf.description)]),
        { width: total, gap: 3, wrap: true }
      )
    );
  }

  lines.push('');
  lines.push(t.heading('Options'));
  lines.push(
    ...columns(
      [
        [t.accent('-h, --help'), 'Show help for any command'],
        [t.accent('-V, --version'), 'Print the version'],
        [t.accent('--json'), 'One JSON envelope on stdout, nothing else'],
        [t.accent('--no-color'), 'Plain text, also honoured through NO_COLOR'],
        [t.accent('--color'), 'Keep colour when piping']
      ].map(([term, text]) => [padEnd(term!, termWidth), text!]),
      { width: total, gap: 3, wrap: true }
    )
  );
  lines.push(...exampleLines(''));
  lines.push('');
  lines.push(`${t.muted('Help for one command:')} ${t.command('globalpayments <command> --help')}`);
  lines.push(`${t.muted('Docs:')} ${t.link(DOCS_URL)}`);
  lines.push('');
  return lines.join('\n');
}

function formatCommandHelp(command: Command, helper: Help): string {
  const lines: string[] = [];
  const total = width();
  const path = commandPath(command);
  lines.push('');
  lines.push(`${t.heading(`globalpayments ${path}`)}`);
  const description = helper.commandDescription(command);
  if (description) {
    lines.push(description);
  }
  lines.push('');
  lines.push(t.heading('Usage'));
  lines.push(`  ${t.muted('$')} ${t.command(helper.commandUsage(command))}`);

  const args = helper.visibleArguments(command);
  if (args.length > 0) {
    lines.push('');
    lines.push(t.heading('Arguments'));
    lines.push(
      ...columns(
        args.map((argument) => [t.accent(helper.argumentTerm(argument)), helper.argumentDescription(argument)]),
        { width: total, gap: 3, wrap: true }
      )
    );
  }

  const subcommands = helper.visibleCommands(command).filter((sub) => sub.name() !== 'help');
  if (subcommands.length > 0) {
    lines.push('');
    lines.push(t.heading('Commands'));
    lines.push(
      ...columns(
        subcommands.map((sub) => {
          const args = argumentPlaceholders(sub);
          return [t.accent(args ? `${sub.name()} ${args}` : sub.name()), summaryFor(commandPath(sub), sub.description())];
        }),
        { width: total, gap: 3, wrap: true }
      )
    );
  }

  const options = helper.visibleOptions(command);
  if (options.length > 0) {
    lines.push('');
    lines.push(t.heading('Options'));
    lines.push(
      ...columns(
        options.map((option) => [t.accent(helper.optionTerm(option)), helper.optionDescription(option)]),
        { width: total, gap: 3, wrap: true }
      )
    );
  }

  lines.push(...exampleLines(path));
  if (subcommands.length > 0) {
    lines.push('');
    lines.push(`${t.muted('Help for one command:')} ${t.command(`globalpayments ${path} <command> --help`)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Install the formatter. Call on the root before registering commands so they inherit it. */
export function installHelp(program: Command): void {
  program.configureHelp({
    formatHelp: (command, helper) => (command.parent ? formatCommandHelp(command, helper) : formatRootHelp(command)),
    helpWidth: width(),
    sortSubcommands: false,
    sortOptions: false
  });
}

/**
 * Style commander's own error messages ("unknown command", "did you mean") to
 * match the rest of the CLI, and point at help.
 */
export function formatCommanderError(message: string, path = ''): string {
  const text = message.replace(/^error:\s*/i, '').trimEnd();
  const [first, ...rest] = text.split('\n');
  const lines = [`${t.danger(sym().fail)} ${first ?? ''}`];
  for (const line of rest) {
    lines.push(`  ${t.muted(line.replace(/^\((.*)\)$/, '$1'))}`);
  }
  const help = humanCommand(path ? `globalpayments ${path} --help` : 'globalpayments --help');
  lines.push(`  ${t.muted('See')} ${t.command(help)}${path ? '' : `${t.muted(', or run')} ${t.command('globalpayments')} ${t.muted('for the interactive shell')}`}${t.muted('.')}`);
  return `${lines.join('\n')}\n`;
}
