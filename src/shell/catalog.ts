import type { Command, Option } from 'commander';
import { readdirSync } from 'node:fs';
import { COMMAND_GROUPS, commandPath, leafCommands, summaryFor } from '../ui/help.js';
import { SETTING_DEFINITIONS } from '../ui/settings.js';
import { THEME_NAMES } from '../ui/theme.js';
import { currentToken, tokenize } from './tokenize.js';

/**
 * The shell's view of the command tree: every CLI command plus the shell's own
 * built-ins, and the completion logic that drives the live palette and Tab.
 * Built from the real commander tree, so a new command shows up in the shell,
 * its palette and its completions without being listed anywhere else.
 */

export interface BuiltinCommand {
  name: string;
  aliases?: string[];
  args?: string;
  description: string;
  values?: () => string[];
}

export const BUILTINS: BuiltinCommand[] = [
  { name: 'help', args: '[command]', description: 'List commands, or show help for one' },
  {
    name: 'theme',
    args: '[name]',
    description: 'Preview the colour themes, or switch to one',
    values: () => ['auto', ...THEME_NAMES]
  },
  { name: 'banner', args: '[full|compact|off]', description: 'Choose the banner shown at start', values: () => ['full', 'compact', 'off'] },
  { name: 'env', description: 'Show the environment and credentials in use' },
  { name: 'history', description: 'Show recent commands' },
  { name: 'docs', description: 'Developer portal and API reference links' },
  { name: 'clear', description: 'Clear the screen' },
  { name: 'version', description: 'Print the CLI version' },
  { name: 'exit', aliases: ['quit', 'q'], description: 'Leave the shell' }
];

export interface Suggestion {
  /** Text that replaces the token being completed. */
  value: string;
  /** What the palette shows on the left. */
  label: string;
  description?: string;
  /** Appended after acceptance: a space when more input naturally follows. */
  suffix?: string;
  /** Command group, for grouping in the palette. */
  kind: 'command' | 'builtin' | 'option' | 'value';
}

export interface SuggestionSet {
  items: Suggestion[];
  /** Range in the line that an accepted suggestion replaces. */
  start: number;
  end: number;
  /** Shown above the items, e.g. the usage of the command being typed. */
  title?: string;
}

export interface DynamicValues {
  packIds: () => string[];
  caseAddresses: () => string[];
  cwd?: () => string;
}

/** Score a candidate against a query: prefix beats word-prefix beats subsequence. 0 is no match. */
export function matchScore(candidate: string, query: string): number {
  const c = candidate.toLowerCase();
  const q = query.toLowerCase();
  if (q === '') return 1;
  if (c === q) return 100;
  if (c.startsWith(q)) return 80 - Math.min(20, c.length - q.length);
  const words = c.split(/[\s:._-]+/);
  if (words.some((word) => word.startsWith(q))) return 50;
  if (c.includes(q)) return 30;
  let position = 0;
  for (const char of q) {
    position = c.indexOf(char, position);
    if (position === -1) return 0;
    position += 1;
  }
  return 10;
}

function rank<T extends { label: string }>(items: T[], query: string, key: (item: T) => string = (item) => item.label): T[] {
  return items
    .map((item, order) => ({ item, order, score: matchScore(key(item), query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((entry) => entry.item);
}

function longFlag(option: Option): string | undefined {
  return option.long ?? option.short;
}

function takesValue(option: Option): boolean {
  return option.required || option.optional;
}

function listFiles(cwd: string, pattern: RegExp): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export class Catalog {
  readonly leaves: ReturnType<typeof leafCommands>;
  private readonly order: Map<string, number>;

  constructor(
    private readonly root: Command,
    private readonly dynamic: DynamicValues
  ) {
    // The shell is where you already are; offering it again only confuses.
    this.leaves = leafCommands(root).filter((leaf) => leaf.path !== 'shell');
    const ordered = COMMAND_GROUPS.flatMap((group) => group.commands);
    this.order = new Map(ordered.map((path, index) => [path, index]));
    this.leaves.sort((a, b) => (this.order.get(a.path) ?? 999) - (this.order.get(b.path) ?? 999));
  }

  builtin(name: string): BuiltinCommand | undefined {
    const lower = name.toLowerCase();
    return BUILTINS.find((b) => b.name === lower || b.aliases?.includes(lower));
  }

  /** Walk the tree along `words`; returns the deepest command reached and how many words it used. */
  resolve(words: string[]): { command: Command; consumed: number } {
    let command = this.root;
    let consumed = 0;
    for (const word of words) {
      const next = command.commands.find((child) => child.name() === word || child.aliases().includes(word));
      if (!next) break;
      command = next;
      consumed += 1;
    }
    return { command, consumed };
  }

  /** Every command name the shell accepts, for "did you mean". */
  allNames(): string[] {
    return [...this.leaves.map((leaf) => leaf.path), ...BUILTINS.map((b) => b.name)];
  }

  /** Closest known commands to something that did not resolve. */
  didYouMean(input: string, limit = 3): string[] {
    const scored = this.allNames()
      .map((name) => ({ name, distance: editDistance(name, input), score: matchScore(name, input) }))
      .filter((entry) => entry.distance <= Math.max(2, Math.floor(input.length / 3)) || entry.score >= 50)
      .sort((a, b) => a.distance - b.distance || b.score - a.score);
    return scored.slice(0, limit).map((entry) => entry.name);
  }

  private commandSuggestions(query: string): Suggestion[] {
    const commands: Suggestion[] = this.leaves.map((leaf) => ({
      value: leaf.path,
      label: leaf.term,
      description: summaryFor(leaf.path, leaf.description),
      suffix: ' ',
      kind: 'command'
    }));
    const builtins: Suggestion[] = BUILTINS.map((b) => ({
      value: b.name,
      label: b.args ? `${b.name} ${b.args}` : b.name,
      description: b.description,
      suffix: b.args ? ' ' : '',
      kind: 'builtin'
    }));
    // Real commands edge out shell built-ins on a close call ("/doc" means doctor,
    // not docs), except help and exit, which are what people reach for most.
    const boost = (item: Suggestion): number =>
      query === '' ? 0 : item.kind === 'command' ? 3 : item.value === 'help' || item.value === 'exit' ? 6 : 0;
    return [...commands, ...builtins]
      .map((item, order) => ({ item, order, score: matchScore(item.value, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score + boost(b.item) - (a.score + boost(a.item)) || a.order - b.order)
      .map((entry) => entry.item);
  }

  /** Values for an option or positional argument, keyed by command path. */
  private valuesFor(path: string, key: string): string[] | undefined {
    const cwd = this.dynamic.cwd?.() ?? process.cwd();
    switch (key) {
      case '--cert':
      case '--pack':
        return this.dynamic.packIds();
      case '--editor':
        return ['claude-code', 'cursor', 'vscode'];
      case '--status':
        return ['4xx', '5xx', '400', '401', '403', '404', '409', '422', '500', '502', '503'];
      case '--timeout':
        return ['30s', '1m', '5m', '10m', '30m'];
      case '--interval':
        return ['1s', '3s', '5s', '10s'];
      case '--env-file':
        return listFiles(cwd, /^\.env/);
      case '--config':
        return listFiles(cwd, /\.(ya?ml|json)$/);
      case '--data-file':
        return listFiles(cwd, /\.json$/);
      case '--input':
        return listFiles(cwd, /\.json$/);
      case '--currency':
        return ['EUR', 'GBP', 'USD', 'CAD', 'AUD'];
      case '--country':
        return ['IE', 'GB', 'US', 'CA', 'AU'];
      default:
        break;
    }
    switch (`${path}#${key}`) {
      case 'packs show#0':
        return this.dynamic.packIds();
      case 'cases show#0':
      case 'diagnose#0':
        return this.dynamic.caseAddresses();
      case 'trigger#0':
        return ['transaction.captured', 'transaction.declined', 'transaction.refunded', 'transaction.reversed', 'transaction.preauthorized'];
      case 'completion#0':
        return ['bash', 'zsh', 'fish'];
      case 'ui set#0':
      case 'ui reset#0':
        return SETTING_DEFINITIONS.map((d) => d.key);
      default:
        return undefined;
    }
  }

  /**
   * Suggestions for the token under the cursor. `slash` says whether the line is
   * a slash command; the leading "/" is not part of any token.
   */
  suggest(line: string, cursor: number): SuggestionSet | undefined {
    const slash = line.startsWith('/');
    const offset = slash ? 1 : 0;
    const body = line.slice(offset);
    const bodyCursor = Math.max(0, cursor - offset);
    const token = currentToken(body, bodyCursor);
    const before = tokenize(body.slice(0, token.start)).args;
    const start = token.start + offset;

    // First word: commands and built-ins.
    if (before.length === 0) {
      const items = this.commandSuggestions(token.text);
      return { items, start, end: cursor };
    }

    const first = before[0]!;
    const builtin = this.builtin(first);
    if (builtin && this.resolve([first]).consumed === 0) {
      if (before.length === 1) {
        const values =
          builtin.name === 'help' ? this.leaves.map((leaf) => leaf.path.split(' ')[0]!).filter((v, i, a) => a.indexOf(v) === i) : builtin.values?.();
        if (!values) return undefined;
        const items = rank(
          values.map((value) => ({ value, label: value, kind: 'value' as const, suffix: '' })),
          token.text
        );
        return { items, start, end: cursor, title: `/${builtin.name} ${builtin.args ?? ''}`.trim() };
      }
      return undefined;
    }

    const { command, consumed } = this.resolve(before);
    if (consumed === 0) return undefined;
    const path = commandPath(command);

    // A group whose subcommand is still being typed.
    if (consumed === before.length && command.commands.length > 0) {
      const items = rank(
        command.commands.map((sub) => ({
          value: sub.name(),
          label: sub.name(),
          description: summaryFor(commandPath(sub), sub.description()),
          suffix: ' ',
          kind: 'command' as const
        })),
        token.text
      );
      return { items, start, end: cursor, title: `/${path} <command>` };
    }

    const title = `/${leafCommands(this.root).find((leaf) => leaf.path === path)?.term ?? path}`;
    const args = before.slice(consumed);
    const options = command.options.filter((option) => !option.hidden);

    // Value for the option just typed.
    const previous = args[args.length - 1];
    const previousOption = previous?.startsWith('-') ? options.find((o) => o.long === previous || o.short === previous) : undefined;
    if (previousOption && takesValue(previousOption)) {
      const values = this.valuesFor(path, previousOption.long ?? '');
      if (!values) return { items: [], start, end: cursor, title: `${previousOption.flags}  ${previousOption.description}` };
      const items = rank(
        values.map((value) => ({ value, label: value, kind: 'value' as const, suffix: ' ' })),
        token.text
      );
      return { items, start, end: cursor, title: previousOption.flags };
    }

    // Options.
    if (token.text.startsWith('-')) {
      const used = new Set(args.filter((arg) => arg.startsWith('-')));
      const items = rank(
        options
          .filter((option) => option.variadic || !used.has(longFlag(option) ?? ''))
          .map((option) => ({
            value: longFlag(option) ?? option.flags,
            label: option.flags,
            description: option.description,
            suffix: ' ',
            kind: 'option' as const
          })),
        token.text,
        (item) => item.value
      );
      items.push(
        ...rank([{ value: '--help', label: '-h, --help', description: 'Show help for this command', suffix: '', kind: 'option' as const }], token.text, (i) => i.value)
      );
      return { items, start, end: cursor, title };
    }

    // Positional arguments.
    let positional = 0;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg.startsWith('-')) {
        const option = options.find((o) => o.long === arg || o.short === arg);
        if (option && takesValue(option) && !arg.includes('=')) index += 1;
        continue;
      }
      positional += 1;
    }
    const values = this.valuesFor(path, `${positional}`);
    if (values) {
      const items = rank(
        values.map((value) => ({ value, label: value, kind: 'value' as const, suffix: ' ' })),
        token.text
      );
      return { items, start, end: cursor, title };
    }
    return { items: [], start, end: cursor, title };
  }
}

/** Levenshtein distance, for "did you mean". */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[] = Array.from({ length: rows * cols }, () => 0);
  for (let i = 0; i < rows; i += 1) dist[i * cols] = i;
  for (let j = 0; j < cols; j += 1) dist[j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dist[i * cols + j] = Math.min(dist[(i - 1) * cols + j]! + 1, dist[i * cols + j - 1]! + 1, dist[(i - 1) * cols + j - 1]! + cost);
    }
  }
  return dist[rows * cols - 1]!;
}
