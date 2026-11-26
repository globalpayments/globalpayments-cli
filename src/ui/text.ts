import { wrapText } from './ansi.js';
import { terminalColumns } from './capabilities.js';
import { colorLevel, t } from './index.js';

/**
 * Next-step commands are written for agents (`... --json`). A person reading the
 * text output wants the human version, and inside the shell the slash form they
 * can type straight back. The JSON envelope always keeps the original.
 */
export function humanCommand(command: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = command.replace(/\s--json(?=\s|$)/g, '');
  if (env.GP_CLI_SHELL === '1') out = out.replace(/^globalpayments\s+/, '/');
  return out;
}

/** Highlight `backticked` spans in prose as commands, dropping the backticks when colour is on. */
export function inlineCode(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (colorLevel() === 0) return text;
  return text.replace(/`([^`]+)`/g, (_, code: string) => t.command(code.startsWith('globalpayments ') ? humanCommand(code, env) : code));
}

/**
 * Pretty-print JSON with colour for a terminal. Plain `JSON.stringify` output
 * when colour is off, so `api get ... > file.json` still writes valid JSON.
 */
export function highlightJson(value: unknown, indent = 2): string {
  const text = JSON.stringify(value, null, indent);
  if (text === undefined) return '';
  if (colorLevel() === 0) return text;
  return text.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str: string | undefined, colon: string | undefined, literal: string | undefined, number: string | undefined) => {
      if (str !== undefined) return colon ? `${t.accent(str)}${colon}` : str;
      if (literal !== undefined) return literal === 'null' ? t.muted(literal) : t.strong(literal);
      if (number !== undefined) return t.command(number);
      return match;
    }
  );
}

/**
 * Drop empty strings, nulls and the objects or arrays left empty by that, and
 * count what was dropped. GP API responses carry dozens of blank fields per
 * record; hiding them is what makes a response readable at a glance.
 */
export function pruneEmpty(value: unknown): { value: unknown; removed: number } {
  let removed = 0;
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const items = node.map(visit).filter((item) => item !== undefined);
      return items.length > 0 ? items : undefined;
    }
    if (node && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
        .map(([key, child]) => [key, visit(child)] as const)
        .filter(([, child]) => child !== undefined);
      return entries.length > 0 ? Object.fromEntries(entries) : undefined;
    }
    if (node === '' || node === null) {
      removed += 1;
      return undefined;
    }
    return node;
  };
  const result = visit(value);
  return { value: result === undefined ? (Array.isArray(value) ? [] : {}) : result, removed };
}

/**
 * Wrap prose under a hanging indent when it is going to a terminal, so long
 * remediation text breaks between words instead of wherever the terminal cuts
 * it. Off a terminal it stays one line, which keeps logs greppable.
 */
export function hang(text: string, indent: number, stream: { isTTY?: boolean; columns?: number } = process.stdout): string {
  if (!stream.isTTY) return text;
  const width = Math.max(24, terminalColumns(stream) - indent);
  return wrapText(text, width).join(`\n${' '.repeat(indent)}`);
}
