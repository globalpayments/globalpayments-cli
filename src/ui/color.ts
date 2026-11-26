import type { ColorLevel } from './capabilities.js';

/**
 * A colour that degrades with the terminal: an exact hex value for 24-bit and
 * 256-colour terminals, and a basic SGR code (30-37, 90-97) for everything else.
 * A spec with no hex always uses the terminal's own palette, which is what the
 * `classic` theme and every muted grey want.
 */
export interface ColorSpec {
  hex?: string;
  basic: number;
}

export interface TextStyle {
  fg?: ColorSpec;
  bg?: ColorSpec;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export type Paint = (text: string) => string;

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Nearest xterm-256 index, using the 6x6x6 cube or the grey ramp, whichever is closer. */
export function rgbToAnsi256(r: number, g: number, b: number): number {
  const levels = [0, 95, 135, 175, 215, 255];
  const nearest = (v: number): number => {
    let best = 0;
    for (let i = 1; i < levels.length; i += 1) {
      if (Math.abs(levels[i]! - v) < Math.abs(levels[best]! - v)) best = i;
    }
    return best;
  };
  const ri = nearest(r);
  const gi = nearest(g);
  const bi = nearest(b);
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeDistance = (levels[ri]! - r) ** 2 + (levels[gi]! - g) ** 2 + (levels[bi]! - b) ** 2;

  const average = (r + g + b) / 3;
  const greyIndex = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
  const grey = 8 + greyIndex * 10;
  const greyDistance = (grey - r) ** 2 + (grey - g) ** 2 + (grey - b) ** 2;

  return greyDistance < cubeDistance ? 232 + greyIndex : cube;
}

function colorCode(spec: ColorSpec, level: ColorLevel, background: boolean): string {
  if (spec.hex && level === 3) {
    const [r, g, b] = hexToRgb(spec.hex);
    return `${background ? 48 : 38};2;${r};${g};${b}`;
  }
  if (spec.hex && level === 2) {
    const [r, g, b] = hexToRgb(spec.hex);
    return `${background ? 48 : 38};5;${rgbToAnsi256(r, g, b)}`;
  }
  return String(background ? spec.basic + 10 : spec.basic);
}

/**
 * Build a painter for a style at a colour level. Level 0 returns the text
 * untouched: no colour and no bold, because level 0 means "not a terminal" or
 * "the user said no" and either way escape codes would be noise.
 *
 * Each attribute closes with its own reset (39, 49, 22...) rather than a full
 * reset, and any matching close inside the text is re-opened, so painted spans
 * nest the way they read.
 */
export function painter(style: TextStyle, level: ColorLevel): Paint {
  if (level === 0) return (text) => text;
  const pairs: Array<[string, string]> = [];
  if (style.bold) pairs.push(['1', '22']);
  if (style.dim) pairs.push(['2', '22']);
  if (style.italic) pairs.push(['3', '23']);
  if (style.underline) pairs.push(['4', '24']);
  if (style.fg) pairs.push([colorCode(style.fg, level, false), '39']);
  if (style.bg) pairs.push([colorCode(style.bg, level, true), '49']);
  if (pairs.length === 0) return (text) => text;

  const open = pairs.map(([o]) => `\x1B[${o}m`).join('');
  const closes = pairs.map(([, c]) => `\x1B[${c}m`);
  const close = [...new Set(closes)].join('');

  return (text: string) => {
    if (text === '') return '';
    let body = text;
    // Re-open after any nested close of the same attribute so the outer style survives.
    for (const [index, closeCode] of closes.entries()) {
      if (body.includes(closeCode)) {
        body = body.split(closeCode).join(closeCode + `\x1B[${pairs[index]![0]}m`);
      }
    }
    return open + body + close;
  };
}
