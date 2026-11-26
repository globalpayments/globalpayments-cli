/**
 * ANSI-aware string measurement.
 *
 * Everything that lays text out in columns (help, tables, the shell palette, the
 * banner) has to know how wide a string will be on screen, which is not its
 * `.length`: escape sequences take no space, combining marks take none, and CJK
 * and emoji take two cells.
 */

// CSI sequences (colours, cursor moves) and OSC sequences (titles, hyperlinks).
const ANSI_PATTERN = /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
const ANSI_AT_START = /^(?:\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\))/;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) || // combining diacritics
    (code >= 0x200b && code <= 0x200f) || // zero-width space, joiners, marks
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    code === 0x2060 ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** On-screen width of one code point. Control characters count as zero. */
export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (isZeroWidth(code)) return 0;
  return isWide(code) ? 2 : 1;
}

/** On-screen width of a string, ignoring escape sequences. */
export function stringWidth(input: string): number {
  let width = 0;
  for (const char of stripAnsi(input)) {
    width += charWidth(char);
  }
  return width;
}

/**
 * Cut a string down to `width` cells, keeping its escape sequences intact and
 * ending with an ellipsis when anything was dropped. A reset is appended if the
 * input was styled, so a cut never leaks colour into whatever follows.
 */
export function truncate(input: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  if (stringWidth(input) <= width) return input;
  const ellipsisWidth = stringWidth(ellipsis);
  const budget = Math.max(0, width - ellipsisWidth);
  let output = '';
  let used = 0;
  let styled = false;
  let rest = input;
  while (rest.length > 0) {
    const escape = ANSI_AT_START.exec(rest);
    if (escape) {
      output += escape[0];
      styled = true;
      rest = rest.slice(escape[0].length);
      continue;
    }
    const char = String.fromCodePoint(rest.codePointAt(0) ?? 0);
    const charCells = charWidth(char);
    if (used + charCells > budget) break;
    output += char;
    used += charCells;
    rest = rest.slice(char.length);
  }
  const tail = width >= ellipsisWidth ? ellipsis : '';
  return styled ? `${output}\x1B[0m${tail}` : `${output}${tail}`;
}

/** Pad (or cut) to exactly `width` cells. */
export function padEnd(input: string, width: number): string {
  const clipped = truncate(input, width);
  return clipped + ' '.repeat(Math.max(0, width - stringWidth(clipped)));
}

export function padStart(input: string, width: number): string {
  const clipped = truncate(input, width);
  return ' '.repeat(Math.max(0, width - stringWidth(clipped))) + clipped;
}

/**
 * Word-wrap plain text to `width` cells. Words longer than a line are split.
 * Existing newlines are kept. Styling should be applied after wrapping.
 */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/ +/)) {
      if (word === '') continue;
      let piece = word;
      while (stringWidth(piece) > limit) {
        if (line) {
          lines.push(line);
          line = '';
        }
        let head = '';
        for (const char of piece) {
          if (stringWidth(head + char) > limit) break;
          head += char;
        }
        lines.push(head);
        piece = piece.slice(head.length);
      }
      if (!line) {
        line = piece;
      } else if (stringWidth(line) + 1 + stringWidth(piece) <= limit) {
        line += ` ${piece}`;
      } else {
        lines.push(line);
        line = piece;
      }
    }
    lines.push(line);
  }
  return lines;
}
