import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function normalizedRule(value: string): string {
  return value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function ruleCovers(entry: string, rule: string): boolean {
  const normalizedEntry = normalizedRule(entry);
  const normalizedExisting = normalizedRule(rule);
  if (!normalizedExisting || rule.trim().startsWith('!')) return false;
  return (
    normalizedEntry === normalizedExisting ||
    normalizedEntry.startsWith(`${normalizedExisting}/`) ||
    (!rule.includes('/') && normalizedEntry.split('/').at(-1) === normalizedExisting)
  );
}

export function mergeGitignore(contents: string, entries: string[]): string {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents.split(/\r?\n/);
  const missing = entries.filter((entry) => !lines.some((line) => ruleCovers(entry, line)));
  if (missing.length === 0) return contents;

  let prefix = contents;
  if (prefix && !prefix.endsWith('\n')) prefix += newline;
  if (prefix && !prefix.endsWith(`${newline}${newline}`)) prefix += newline;
  return `${prefix}${missing.join(newline)}${newline}`;
}

export async function ensureGitignoreEntries(root: string, entries: string[]): Promise<string | undefined> {
  const ignorePath = path.join(root, '.gitignore');
  const existing = existsSync(ignorePath) ? await readFile(ignorePath, 'utf8') : '';
  const updated = mergeGitignore(existing, entries);
  if (updated === existing) return undefined;
  await writeFile(ignorePath, updated, 'utf8');
  return ignorePath;
}
