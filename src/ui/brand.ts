import { stringWidth } from './ansi.js';
import { colorLevel, t } from './index.js';
import { WORDMARK } from './wordmark.js';

export const PRODUCT_NAME = 'Global Payments CLI';
export const DOCS_URL = 'https://developer.globalpayments.com';

export type BannerMode = 'full' | 'compact' | 'off';

/** Below this many rows the banner would push the prompt off a small window. */
const MIN_BANNER_ROWS = 16;

/**
 * The one-line lockup: the 'g' brand symbol as a chip, then the wordmark in the
 * guide's two weights (Black "global", Light "payments").
 */
export function lockup(): string {
  if (colorLevel() === 0) return 'global payments';
  return `${t.logo(t.strong(' g '))} ${t.strong('global')}payments`;
}

/** The ASCII wordmark if it fits in `columns` (after any indent) and `rows`, or none. */
export function chooseWordmark(columns: number, rows: number): readonly string[] | undefined {
  if (rows < MIN_BANNER_ROWS) return undefined;
  if (columns < Math.max(...WORDMARK.map((line) => stringWidth(line)))) return undefined;
  return WORDMARK;
}

/**
 * The banner as lines, ready to print. Full mode is the plain ASCII wordmark in
 * the terminal's own text colour, whatever the theme. Compact mode, and
 * terminals too narrow or short for the art, get the one-line lockup.
 */
export function renderBanner(options: { mode: BannerMode; columns: number; rows: number; indent?: number }): string[] {
  if (options.mode === 'off') return [];
  const indent = options.indent ?? 1;
  const art = options.mode === 'full' ? chooseWordmark(options.columns - indent, options.rows) : undefined;
  const pad = ' '.repeat(indent);
  if (!art) return [`${pad}${lockup()}`];
  return art.map((line) => `${pad}${line}`);
}

export type EnvironmentKind = 'sandbox' | 'production' | 'none';

/** A pill naming where requests will go. Production is impossible to miss. */
export function environmentBadge(kind: EnvironmentKind): string {
  if (colorLevel() === 0) {
    return kind === 'production' ? '[PRODUCTION]' : kind === 'sandbox' ? '[sandbox]' : '[no credentials]';
  }
  if (kind === 'production') return t.badgeProduction(' PRODUCTION ');
  if (kind === 'sandbox') return t.badgeSandbox(' sandbox ');
  return t.badgeNeutral(' no credentials ');
}
