import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Shell history, kept in the user's config directory.
 *
 * This is a payments tool, so anything that looks like it carries a secret or a
 * card number is kept for the session (so up-arrow still works) but never
 * written to disk: inline JSON bodies, long digit runs, and key or token flags.
 */
const MAX_ENTRIES = 1000;

const SENSITIVE = [
  /(?<!\d)\d(?:[ -]?\d){11,18}(?!\d)/, // 12-19 digits, with optional separators: a PAN, even inside card_4111...
  // A long mixed-case token with digits and no resource prefix looks like an app ID or key.
  /(?<![\w-])(?=[A-Za-z0-9]{20,}(?![\w-]))(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+/,
  /--data\b/i, // inline request bodies
  /\b(?:app[_-]?key|secret|password|token|authorization|bearer)\b/i,
  /\bGP_API_APP_KEY\b/
];

export function isSensitive(line: string): boolean {
  return SENSITIVE.some((pattern) => pattern.test(line));
}

export class History {
  private entries: string[] = [];

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      this.entries = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(-MAX_ENTRIES);
    } catch {
      this.entries = [];
    }
  }

  all(): readonly string[] {
    return this.entries;
  }

  add(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (this.entries[this.entries.length - 1] === trimmed) return;
    this.entries.push(trimmed);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    if (!this.file || isSensitive(trimmed) || trimmed.includes('\n')) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${trimmed}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // History is a convenience; a read-only home directory must not break the shell.
    }
  }

  /** Trim the file back to the cap. Called on exit so appends stay cheap. */
  compact(): void {
    if (!this.file) return;
    try {
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MAX_ENTRIES) {
        writeFileSync(this.file, `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
      }
    } catch {
      // Same as above.
    }
  }

  /** Most recent entry that extends `prefix`, for inline suggestions. */
  suggest(prefix: string): string | undefined {
    if (prefix.trim() === '') return undefined;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]!;
      if (entry.length > prefix.length && entry.startsWith(prefix)) return entry;
    }
    return undefined;
  }
}
