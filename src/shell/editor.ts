import { emitKeypressEvents } from 'node:readline';
import { charWidth, stringWidth, stripAnsi, truncate } from '../ui/ansi.js';
import { colorLevel, sym, t } from '../ui/index.js';
import { matchScore, type Suggestion, type SuggestionSet } from './catalog.js';
import type { History } from './history.js';
import { quoteArg } from './tokenize.js';

/**
 * A single-line editor for the shell, written on raw keypresses rather than
 * node:readline so it can draw a live command palette and inline suggestions
 * under the cursor without fighting readline's own redraws.
 *
 * Every keystroke redraws one "frame": the prompt and line (wrapping across rows
 * if long), then the palette or a notice underneath. The frame is cleared and
 * redrawn with relative cursor moves, so it behaves at the bottom of the screen
 * when the terminal scrolls.
 */

export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export type ReadResult =
  | { type: 'line'; line: string }
  | { type: 'interrupt' }
  | { type: 'eof' }
  | { type: 'suspend'; line: string };

export interface EditorInput extends NodeJS.EventEmitter {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface EditorOutput {
  write(chunk: string): unknown;
  columns?: number;
  rows?: number;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

export interface EditorOptions {
  input: EditorInput;
  output: EditorOutput;
  prompt: () => string;
  suggest: (line: string, cursor: number) => SuggestionSet | undefined;
  history: History;
  /** Live palette and inline suggestions. */
  hints: () => boolean;
  /** Render synchronously (tests) instead of once per tick. */
  synchronous?: boolean;
}

const MAX_PALETTE_ITEMS = 8;

export class LineEditor {
  line = '';
  cursor = 0;
  notice: string | undefined;

  private palette: SuggestionSet | undefined;
  private selected = 0;
  private scroll = 0;
  /** Esc closes the palette until the line changes. */
  private dismissed = false;
  /** Tab opens the palette even for lines without a slash. */
  private forced = false;
  private pasting = false;
  private historyIndex: number | undefined;
  private historyDraft = '';
  private renderedCursorRow = 0;
  private renderScheduled = false;
  private active = false;
  private resolve: ((result: ReadResult) => void) | undefined;
  private readonly onKeypress = (str: string | undefined, key: Key | undefined): void => this.handleKey(str, key ?? {});
  private readonly onResize = (): void => this.scheduleRender();

  constructor(private readonly options: EditorOptions) {}

  /** Read one line. Resolves on Enter, Ctrl+C, Ctrl+D or Ctrl+Z. */
  read(initial: { notice?: string; line?: string } = {}): Promise<ReadResult> {
    this.line = initial.line ?? '';
    this.cursor = this.line.length;
    this.notice = initial.notice;
    this.palette = undefined;
    this.selected = 0;
    this.scroll = 0;
    this.dismissed = false;
    this.forced = false;
    this.pasting = false;
    this.historyIndex = undefined;
    this.renderedCursorRow = 0;
    this.attach();
    this.refreshPalette();
    this.render();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  private attach(): void {
    if (this.active) return;
    this.active = true;
    const { input, output } = this.options;
    emitKeypressEvents(input as NodeJS.ReadableStream);
    if (input.isTTY) input.setRawMode?.(true);
    input.on('keypress', this.onKeypress);
    input.resume();
    output.on?.('resize', this.onResize);
    // Bracketed paste: a pasted newline must never run a half-pasted command.
    output.write('\x1B[?2004h');
  }

  /** End a pending read as if Ctrl+D was pressed (the shell is being terminated). */
  cancel(): void {
    if (!this.resolve) return;
    this.commit();
    this.finish({ type: 'eof' });
  }

  /** Give the terminal back (before running a command, on exit). */
  detach(): void {
    if (!this.active) return;
    this.active = false;
    const { input, output } = this.options;
    input.off('keypress', this.onKeypress);
    output.off?.('resize', this.onResize);
    output.write('\x1B[?2004l\x1B[?25h');
    if (input.isTTY) input.setRawMode?.(false);
    input.pause();
  }

  private finish(result: ReadResult): void {
    const resolve = this.resolve;
    this.resolve = undefined;
    this.detach();
    resolve?.(result);
  }

  // ---------------------------------------------------------------- editing

  private setLine(line: string, cursor = line.length): void {
    this.line = line;
    this.cursor = Math.max(0, Math.min(cursor, line.length));
    this.dismissed = false;
    this.notice = undefined;
    this.historyIndex = undefined;
    this.refreshPalette();
  }

  private insert(text: string): void {
    const clean = text.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1F\x7F]/g, '');
    if (!clean) return;
    this.setLine(this.line.slice(0, this.cursor) + clean + this.line.slice(this.cursor), this.cursor + clean.length);
  }

  /** Index of the code point before `index`, so an emoji is never split in half. */
  private prevIndex(index: number): number {
    if (index <= 0) return 0;
    const low = this.line.charCodeAt(index - 1);
    const high = index >= 2 ? this.line.charCodeAt(index - 2) : 0;
    return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? index - 2 : index - 1;
  }

  private nextIndex(index: number): number {
    if (index >= this.line.length) return this.line.length;
    const high = this.line.charCodeAt(index);
    const low = this.line.charCodeAt(index + 1);
    return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? index + 2 : index + 1;
  }

  private deleteForward(): void {
    if (this.cursor < this.line.length) {
      this.setLine(this.line.slice(0, this.cursor) + this.line.slice(this.nextIndex(this.cursor)), this.cursor);
    }
  }

  private wordLeft(from: number): number {
    let index = from;
    while (index > 0 && /\s/.test(this.line[index - 1]!)) index -= 1;
    while (index > 0 && !/[\s/]/.test(this.line[index - 1]!)) index -= 1;
    return index;
  }

  private wordRight(from: number): number {
    let index = from;
    while (index < this.line.length && /\s/.test(this.line[index]!)) index += 1;
    while (index < this.line.length && !/\s/.test(this.line[index]!)) index += 1;
    return index;
  }

  private moveCursor(to: number): void {
    this.cursor = Math.max(0, Math.min(to, this.line.length));
    this.refreshPalette(false);
  }

  // ---------------------------------------------------------------- palette

  private paletteVisible(): boolean {
    return Boolean(this.palette && (this.palette.items.length > 0 || this.palette.title));
  }

  /**
   * Recompute suggestions. New text means a new best match, so the selection goes
   * back to the top; moving the cursor keeps whatever was picked if it is still offered.
   */
  private refreshPalette(textChanged = true): void {
    const live = this.options.hints() && this.line.startsWith('/');
    if (this.dismissed || (!live && !this.forced)) {
      this.palette = undefined;
      return;
    }
    const previous = textChanged ? undefined : this.palette?.items[this.selected]?.value;
    this.palette = this.options.suggest(this.line, this.cursor);
    this.selected = 0;
    this.scroll = 0;
    if (!this.palette) return;
    const keep = previous ? this.palette.items.findIndex((item) => item.value === previous) : -1;
    if (keep >= 0) this.selected = keep;
    this.clampScroll();
  }

  private clampScroll(): void {
    const visible = this.visibleCount();
    if (this.selected < this.scroll) this.scroll = this.selected;
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, (this.palette?.items.length ?? 0) - visible)));
  }

  private visibleCount(): number {
    const rows = this.options.output.rows ?? 24;
    return Math.max(1, Math.min(MAX_PALETTE_ITEMS, rows - 5));
  }

  private selectedSuggestion(): Suggestion | undefined {
    return this.palette?.items[this.selected];
  }

  private accept(item: Suggestion): void {
    if (!this.palette) return;
    const value = item.kind === 'value' ? quoteArg(item.value) : item.value;
    const head = this.line.slice(0, this.palette.start) + value + (item.suffix ?? '');
    const tail = this.line.slice(this.palette.end);
    this.forced = false;
    this.setLine(head + (item.suffix ? tail.replace(/^ +/, '') : tail), head.length);
  }

  /** The palette's selection completes the token being typed, or there is nothing to complete. */
  private completesTypedToken(item: Suggestion): boolean {
    if (!this.palette) return false;
    const typed = this.line.slice(this.palette.start, this.palette.end);
    return item.value.toLowerCase() !== typed.toLowerCase();
  }

  /** Inline suggestion: the selected item's remainder, or a matching history entry. */
  private ghost(): string {
    // Without colour a suggestion would look exactly like typed text, so there is none.
    if (colorLevel() === 0 || !this.options.hints() || this.cursor !== this.line.length || this.line === '') return '';
    const item = this.selectedSuggestion();
    if (item && this.palette) {
      const typed = this.line.slice(this.palette.start, this.palette.end);
      if (typed && item.value.toLowerCase().startsWith(typed.toLowerCase())) return item.value.slice(typed.length);
      return '';
    }
    if (this.paletteVisible()) return '';
    const fromHistory = this.options.history.suggest(this.line);
    return fromHistory ? fromHistory.slice(this.line.length) : '';
  }

  // ---------------------------------------------------------------- history

  private historyStep(direction: -1 | 1): void {
    const entries = this.options.history.all();
    if (entries.length === 0) return;
    if (this.historyIndex === undefined) {
      if (direction === 1) return;
      this.historyDraft = this.line;
    }
    // With text typed, up and down only visit entries that start with it.
    let index = (this.historyIndex ?? entries.length) + direction;
    while (index >= 0 && index < entries.length && !entries[index]!.startsWith(this.historyDraft)) index += direction;
    if (index < 0) return;
    if (index >= entries.length) {
      this.line = this.historyDraft;
      this.historyIndex = undefined;
    } else {
      this.line = entries[index]!;
      this.historyIndex = index;
    }
    this.cursor = this.line.length;
    this.notice = undefined;
    this.palette = undefined;
  }

  // ---------------------------------------------------------------- keys

  handleKey(str: string | undefined, key: Key): void {
    if (!this.resolve) return;

    if (key.name === 'paste-start') {
      this.pasting = true;
      return;
    }
    if (key.name === 'paste-end') {
      this.pasting = false;
      this.scheduleRender();
      return;
    }
    if (this.pasting) {
      if (str) this.insert(str);
      this.scheduleRender();
      return;
    }

    const name = key.name;
    if (key.ctrl && !key.meta) {
      switch (name) {
        case 'c':
          if (this.line !== '' || this.paletteVisible()) {
            this.setLine('');
            this.forced = false;
            this.palette = undefined;
            this.scheduleRender();
          } else {
            this.commit();
            this.finish({ type: 'interrupt' });
          }
          return;
        case 'd':
          if (this.line === '') {
            this.commit();
            this.finish({ type: 'eof' });
          } else {
            this.deleteForward();
            this.scheduleRender();
          }
          return;
        case 'z':
          if (process.platform !== 'win32') {
            const line = this.line;
            this.commit();
            this.finish({ type: 'suspend', line });
          }
          return;
        case 'a':
          this.moveCursor(0);
          break;
        case 'e':
          this.acceptGhostOr(() => this.moveCursor(this.line.length));
          break;
        case 'b':
          this.moveCursor(this.prevIndex(this.cursor));
          break;
        case 'f':
          this.acceptGhostOr(() => this.moveCursor(this.nextIndex(this.cursor)));
          break;
        case 'u':
          this.setLine(this.line.slice(this.cursor), 0);
          break;
        case 'k':
          this.setLine(this.line.slice(0, this.cursor), this.cursor);
          break;
        case 'w': {
          const to = this.wordLeft(this.cursor);
          this.setLine(this.line.slice(0, to) + this.line.slice(this.cursor), to);
          break;
        }
        case 'h':
          this.backspace();
          break;
        case 'l':
          this.options.output.write('\x1B[2J\x1B[3J\x1B[H');
          this.renderedCursorRow = 0;
          break;
        case 'p':
          this.up();
          break;
        case 'n':
          this.down();
          break;
        case 'left':
          this.moveCursor(this.wordLeft(this.cursor));
          break;
        case 'right':
          this.moveCursor(this.wordRight(this.cursor));
          break;
        default:
          return;
      }
      this.scheduleRender();
      return;
    }

    if (key.meta && name !== 'escape') {
      switch (name) {
        case 'return':
        case 'enter':
          // Esc then Enter typed quickly arrives as one Alt+Enter: close the palette and run what is typed.
          this.dismissed = true;
          this.palette = undefined;
          this.submit();
          return;
        case 'b':
        case 'left':
          this.moveCursor(this.wordLeft(this.cursor));
          break;
        case 'f':
        case 'right':
          this.moveCursor(this.wordRight(this.cursor));
          break;
        case 'backspace': {
          const to = this.wordLeft(this.cursor);
          this.setLine(this.line.slice(0, to) + this.line.slice(this.cursor), to);
          break;
        }
        case 'd': {
          const to = this.wordRight(this.cursor);
          this.setLine(this.line.slice(0, this.cursor) + this.line.slice(to), this.cursor);
          break;
        }
        default:
          return;
      }
      this.scheduleRender();
      return;
    }

    switch (name) {
      case 'return':
      case 'enter':
        this.submit();
        return;
      case 'tab':
        if (key.shift) {
          this.moveSelection(-1);
        } else {
          this.tab();
        }
        break;
      case 'escape':
        if (this.paletteVisible()) {
          this.dismissed = true;
          this.forced = false;
          this.palette = undefined;
        }
        break;
      case 'backspace':
        this.backspace();
        break;
      case 'delete':
        this.deleteForward();
        break;
      case 'left':
        this.moveCursor(this.prevIndex(this.cursor));
        break;
      case 'right':
        this.acceptGhostOr(() => this.moveCursor(this.nextIndex(this.cursor)));
        break;
      case 'home':
        this.moveCursor(0);
        break;
      case 'end':
        this.acceptGhostOr(() => this.moveCursor(this.line.length));
        break;
      case 'up':
        this.up();
        break;
      case 'down':
        this.down();
        break;
      case 'pageup':
        this.moveSelection(-this.visibleCount());
        break;
      case 'pagedown':
        this.moveSelection(this.visibleCount());
        break;
      default:
        if (str && !key.ctrl && !key.meta) {
          this.insert(str);
        } else {
          return;
        }
    }
    this.scheduleRender();
  }

  private backspace(): void {
    if (this.cursor === 0) return;
    const to = this.prevIndex(this.cursor);
    this.setLine(this.line.slice(0, to) + this.line.slice(this.cursor), to);
  }


  private acceptGhostOr(fallback: () => void): void {
    const ghost = this.ghost();
    if (ghost && this.cursor === this.line.length) {
      const item = this.selectedSuggestion();
      if (item && this.palette) {
        this.accept(item);
      } else {
        this.setLine(this.line + ghost);
      }
      return;
    }
    fallback();
  }

  private up(): void {
    if (this.paletteVisible() && (this.palette?.items.length ?? 0) > 0) {
      this.moveSelection(-1);
    } else {
      this.historyStep(-1);
    }
  }

  private down(): void {
    if (this.paletteVisible() && (this.palette?.items.length ?? 0) > 0) {
      this.moveSelection(1);
    } else {
      this.historyStep(1);
    }
  }

  private moveSelection(delta: number): void {
    const count = this.palette?.items.length ?? 0;
    if (count === 0) return;
    if (Math.abs(delta) === 1) {
      this.selected = (this.selected + delta + count) % count;
    } else {
      this.selected = Math.max(0, Math.min(count - 1, this.selected + delta));
    }
    this.clampScroll();
  }

  private tab(): void {
    if (!this.paletteVisible() || !this.palette || this.palette.items.length === 0) {
      this.forced = true;
      this.dismissed = false;
      this.refreshPalette();
      const items = this.palette?.items ?? [];
      // One candidate: complete it straight away, the way a shell does.
      if (items.length === 1) this.accept(items[0]!);
      return;
    }
    const item = this.selectedSuggestion();
    if (item) this.accept(item);
  }

  private submit(): void {
    const item = this.selectedSuggestion();
    // "/doc" + Enter runs /doctor: the palette's pick completes a half-typed
    // command name. A name that is already complete (or a group like /api) runs as typed.
    if (item && this.palette && (item.kind === 'command' || item.kind === 'builtin') && this.completesTypedToken(item)) {
      const typed = this.line.slice(this.palette.start, this.palette.end).trim();
      const startsLine = this.line.slice(0, this.palette.start).replace(/^\//, '').trim() === '';
      // Only a confident match (prefix or word start) runs on Enter; "/snd" must not run sandbox create.
      if (startsLine && typed !== '' && !this.isKnownName(typed) && matchScore(item.value, typed) >= 50) {
        this.accept(item);
      }
    }
    // An accepted pick carries a trailing space for the next argument; nothing follows it now.
    this.line = this.line.replace(/\s+$/, '');
    this.cursor = Math.min(this.cursor, this.line.length);
    this.commit();
    this.finish({ type: 'line', line: this.line });
  }

  private isKnownName(typed: string): boolean {
    const set = this.options.suggest(`/${typed}`, typed.length + 1);
    return Boolean(set?.items.some((item) => item.value === typed || item.value.startsWith(`${typed} `)));
  }

  /** Redraw the line on its own, without palette or ghost, and move below it. */
  private commit(): void {
    // Leave the cursor after the text, or the next output would overwrite its tail.
    this.cursor = this.line.length;
    this.palette = undefined;
    this.notice = undefined;
    this.renderFrame(false);
    this.options.output.write('\r\n');
    this.renderedCursorRow = 0;
  }

  // ---------------------------------------------------------------- drawing

  private scheduleRender(): void {
    if (this.options.synchronous) {
      this.render();
      return;
    }
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    setImmediate(() => {
      this.renderScheduled = false;
      if (this.resolve) this.render();
    });
  }

  render(): void {
    this.renderFrame(true);
  }

  private paletteLines(columns: number): string[] {
    const set = this.palette;
    if (!set || !this.paletteVisible()) return [];
    const s = sym();
    const lines: string[] = [];
    const width = columns - 1;
    if (set.title) lines.push(truncate(t.muted(`  ${set.title}`), width));
    const visible = this.visibleCount();
    const shown = set.items.slice(this.scroll, this.scroll + visible);
    const labelWidth = Math.min(30, Math.max(8, ...shown.map((item) => stringWidth(item.label) + (item.kind === 'command' || item.kind === 'builtin' ? 1 : 0))));
    for (const [offset, item] of shown.entries()) {
      const index = this.scroll + offset;
      const isSelected = index === this.selected;
      const prefix = item.kind === 'command' || item.kind === 'builtin' ? '/' : '';
      const label = truncate(`${prefix}${item.label}`, labelWidth);
      const pad = ' '.repeat(Math.max(0, labelWidth - stringWidth(label)));
      const pointer = isSelected ? t.accent(s.pointer) : ' ';
      const text = isSelected ? t.selected(label) : label;
      const description = item.description ? `  ${t.muted(item.description)}` : '';
      lines.push(truncate(`${pointer} ${text}${pad}${description}`, width));
    }
    if (set.items.length === 0 && set.title) {
      return lines;
    }
    const count = set.items.length > visible ? `  ${this.selected + 1}/${set.items.length}` : '';
    lines.push(
      truncate(
        t.muted(`  ${s.upDown} select ${s.dot} tab complete ${s.dot} ${s.enter} run ${s.dot} esc close${count}`),
        width
      )
    );
    return lines;
  }

  private renderFrame(withExtras: boolean): void {
    const { output } = this.options;
    const columns = Math.max(10, output.columns ?? 80);
    const prompt = this.options.prompt();

    // Lay the text out cell by cell the way the terminal will: a wide character
    // that does not fit in the last column wraps whole to the next row.
    const plainPrompt = stripAnsi(prompt);
    const lineEnd = layout(plainPrompt + this.line, columns);
    let ghost = withExtras ? this.ghost() : '';
    const roomOnRow = (lineEnd.col >= columns ? columns : columns - lineEnd.col) - 1;
    if (stringWidth(ghost) > roomOnRow) ghost = roomOnRow > 1 ? truncate(ghost, roomOnRow) : '';

    const end = layout(plainPrompt + this.line + ghost, columns);
    const cursorAt = layout(plainPrompt + this.line.slice(0, this.cursor), columns);
    const cursorRow = cursorAt.col >= columns ? cursorAt.row + 1 : cursorAt.row;
    const cursorCol = cursorAt.col >= columns ? 0 : cursorAt.col;

    let frame = '\x1B[?25l\r';
    if (this.renderedCursorRow > 0) frame += `\x1B[${this.renderedCursorRow}A`;
    frame += '\x1B[J';
    frame += prompt + this.line + (ghost ? t.muted(ghost) : '');

    // Text that ends exactly on the last column leaves the terminal in a pending
    // wrap; step onto the next row explicitly so the row arithmetic stays true.
    const wrapsAtEnd = end.col >= columns;
    const lastRow = wrapsAtEnd ? end.row + 1 : end.row;
    if (wrapsAtEnd) frame += '\r\n';

    const extras: string[] = [];
    if (withExtras) {
      extras.push(...this.paletteLines(columns));
      if (this.notice) extras.push(truncate(t.muted(this.notice), columns - 1));
    }
    for (const extra of extras) frame += `\r\n${extra}`;
    const finalRow = lastRow + extras.length;

    const up = finalRow - cursorRow;
    if (up > 0) frame += `\x1B[${up}A`;
    frame += `\x1B[${cursorCol + 1}G\x1B[?25h`;
    this.renderedCursorRow = cursorRow;
    output.write(frame);
  }
}

/** Where text ends on screen when written from column 0 of a terminal `columns` wide. */
export function layout(text: string, columns: number): { row: number; col: number } {
  let row = 0;
  let col = 0;
  for (const char of text) {
    const width = charWidth(char);
    if (width === 0) continue;
    if (col + width > columns) {
      row += 1;
      col = 0;
    }
    col += width;
  }
  return { row, col };
}
