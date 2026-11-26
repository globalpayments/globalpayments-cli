/**
 * Glyphs with ASCII fallbacks. Status is always carried by a symbol as well as a
 * colour, so it survives colour blindness, NO_COLOR and screen readers.
 */
export interface SymbolSet {
  pass: string;
  fail: string;
  pending: string;
  skip: string;
  warn: string;
  info: string;
  pointer: string;
  arrow: string;
  bullet: string;
  dot: string;
  ellipsis: string;
  rule: string;
  up: string;
  down: string;
  upDown: string;
  enter: string;
  box: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
  spinner: string[];
}

export const UNICODE_SYMBOLS: SymbolSet = {
  pass: '✓',
  fail: '✗',
  pending: '○',
  skip: '–',
  warn: '!',
  info: '›',
  pointer: '❯',
  arrow: '→',
  bullet: '•',
  dot: '·',
  ellipsis: '…',
  rule: '─',
  up: '↑',
  down: '↓',
  upDown: '↑↓',
  enter: '↵',
  box: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
  // The Arc, turning: a nod to the logo's Arc and Ping.
  spinner: ['◜', '◠', '◝', '◞', '◡', '◟']
};

export const ASCII_SYMBOLS: SymbolSet = {
  pass: '+',
  fail: 'x',
  pending: 'o',
  skip: '-',
  warn: '!',
  info: '>',
  pointer: '>',
  arrow: '->',
  bullet: '*',
  dot: '-',
  ellipsis: '...',
  rule: '-',
  up: 'up',
  down: 'down',
  upDown: 'up/down',
  enter: 'enter',
  box: { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' },
  spinner: ['|', '/', '-', '\\']
};
