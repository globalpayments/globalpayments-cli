import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function normalizedRule(value: string): string {
  return value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function ruleMatches(entry: string, rule: string): boolean {
  const pattern = rule.trim().replace(/^!/, '');
  const normalizedEntry = normalizedRule(entry);
  const normalizedPattern = normalizedRule(pattern);
  if (!normalizedPattern || pattern.startsWith('#')) return false;
  // A trailing slash matches directories only, so `.env/` never ignores the file `.env`.
  const sameKind = !pattern.endsWith('/') || entry.trim().endsWith('/');
  return (
    (sameKind && normalizedEntry === normalizedPattern) ||
    normalizedEntry.startsWith(`${normalizedPattern}/`) ||
    (sameKind && !normalizedPattern.includes('/') && normalizedEntry.split('/').at(-1) === normalizedPattern)
  );
}

/** Whether the entry ends up ignored, reading rules in order so a later `!rule` re-includes it. */
function isIgnored(entry: string, lines: string[]): boolean {
  let ignored = false;
  for (const line of lines) {
    if (ruleMatches(entry, line)) ignored = !line.trim().startsWith('!');
  }
  return ignored;
}

export function mergeGitignore(contents: string, entries: string[]): string {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents.split(/\r?\n/);
  const missing = entries.filter((entry) => !isIgnored(entry, lines));
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
