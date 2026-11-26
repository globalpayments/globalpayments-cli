import { padEnd, stringWidth, truncate, wrapText } from './ansi.js';
import { sym, t } from './index.js';

/** A section heading, sentence case, bold. */
export function heading(text: string): string {
  return t.heading(text);
}

export interface ColumnsOptions {
  indent?: number;
  gap?: number;
  /** Total width available; the last column wraps (or truncates) to fit. */
  width?: number;
  /** Wrap the last column onto continuation lines instead of cutting it. */
  wrap?: boolean;
  /** Cap for every column but the last, so one long name cannot push the rest off screen. */
  maxColumnWidth?: number;
}

/**
 * Align rows into columns. Every column but the last is padded to its widest
 * cell; the last takes what is left of the width and wraps under itself.
 */
export function columns(rows: string[][], options: ColumnsOptions = {}): string[] {
  const indent = ' '.repeat(options.indent ?? 2);
  const gap = options.gap ?? 2;
  const width = options.width ?? 80;
  const count = Math.max(0, ...rows.map((row) => row.length));
  if (count === 0) return [];
  const widths: number[] = [];
  for (let col = 0; col < count - 1; col += 1) {
    const widest = Math.max(0, ...rows.map((row) => stringWidth(row[col] ?? '')));
    widths.push(options.maxColumnWidth ? Math.min(widest, options.maxColumnWidth) : widest);
  }
  const lead = indent.length + widths.reduce((sum, w) => sum + w + gap, 0);
  const lastWidth = Math.max(12, width - lead);
  const lines: string[] = [];
  for (const row of rows) {
    const head = widths.map((w, col) => padEnd(row[col] ?? '', w) + ' '.repeat(gap)).join('');
    const last = row[count - 1] ?? '';
    if (options.wrap && stringWidth(last) > lastWidth) {
      const wrapped = wrapText(last, lastWidth);
      lines.push(`${indent}${head}${wrapped[0] ?? ''}`.trimEnd());
      for (const more of wrapped.slice(1)) {
        lines.push(`${' '.repeat(lead)}${more}`.trimEnd());
      }
    } else {
      lines.push(`${indent}${head}${truncate(last, lastWidth)}`.trimEnd());
    }
  }
  return lines;
}

/** Label/value pairs with the labels muted and aligned. */
export function keyValues(rows: Array<[string, string]>, options: ColumnsOptions = {}): string[] {
  return columns(
    rows.map(([label, value]) => [t.muted(label), value]),
    options
  );
}

/** A rounded box around lines of text, with an optional title in the top border. */
export function panel(lines: string[], options: { title?: string; width?: number; indent?: number } = {}): string[] {
  const box = sym().box;
  const indent = ' '.repeat(options.indent ?? 0);
  const inner = Math.max(
    options.width ? options.width - 4 : 0,
    ...lines.map((line) => stringWidth(line)),
    options.title ? stringWidth(options.title) + 2 : 0
  );
  const maxInner = options.width ? options.width - 4 : inner;
  const body = Math.min(inner, maxInner);
  const title = options.title ? ` ${options.title} ` : '';
  const fill = Math.max(0, body + 1 - stringWidth(title));
  const top = t.muted(`${box.tl}${box.h}`) + title + t.muted(`${box.h.repeat(fill)}${box.tr}`);
  const bottom = `${box.bl}${box.h.repeat(body + 2)}${box.br}`;
  return [
    indent + top,
    ...lines.map((line) => `${indent}${t.muted(box.v)} ${padEnd(line, body)} ${t.muted(box.v)}`),
    indent + t.muted(bottom)
  ];
}

/** A thin horizontal rule. */
export function rule(width: number): string {
  return t.muted(sym().rule.repeat(Math.max(0, width)));
}

/**
 * Lay out pre-styled tokens as running text, wrapping between tokens so no
 * colour run is cut and nothing goes past `width`. A token wider than the line
 * gets a line of its own and is cut to fit.
 */
export function flow(tokens: string[], width: number): string[] {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  let line = '';
  for (const raw of tokens) {
    if (!raw) continue;
    const token = truncate(raw, limit);
    if (line && stringWidth(line) + 1 + stringWidth(token) > limit) {
      lines.push(line);
      line = token;
    } else {
      line = line ? `${line} ${token}` : token;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Split plain text into words, each painted on its own so it can wrap anywhere. */
export function styledWords(text: string, paint: (word: string) => string = (word) => word): string[] {
  return text.split(/ +/).filter(Boolean).map(paint);
}
