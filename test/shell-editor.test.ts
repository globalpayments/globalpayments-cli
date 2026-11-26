import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCli } from '../src/cli.js';
import { stringWidth, stripAnsi } from '../src/ui/ansi.js';
import { configureUi, resetUi } from '../src/ui/index.js';
import { Catalog } from '../src/shell/catalog.js';
import { LineEditor, layout, type Key, type ReadResult } from '../src/shell/editor.js';
import { History } from '../src/shell/history.js';

class FakeInput extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  setRawMode(mode: boolean): void {
    this.raw.push(mode);
  }
  resume(): void {}
  pause(): void {}
}

class FakeOutput {
  columns = 80;
  rows = 24;
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get text(): string {
    return this.chunks.join('');
  }
  /** The last frame the editor drew, as plain rows. */
  lastFrame(): string[] {
    const frames = this.text.split('\x1B[?25l');
    return stripAnsi(frames[frames.length - 1] ?? '').replace(/^\r/, '').split('\r\n');
  }
}

const catalog = new Catalog(buildCli(), { packIds: () => ['global-core'], caseAddresses: () => [] });

function setup(options: { hints?: boolean; history?: History } = {}) {
  const input = new FakeInput();
  const output = new FakeOutput();
  const history = options.history ?? new History();
  const editor = new LineEditor({
    input,
    output,
    prompt: () => '> ',
    suggest: (line, cursor) => catalog.suggest(line, cursor),
    history,
    hints: () => options.hints ?? true,
    synchronous: true
  });
  const press = (str: string | undefined, key: Key = {}): void => {
    input.emit('keypress', str, { name: key.name ?? str, ...key });
  };
  const type = (text: string): void => {
    for (const char of text) press(char, { name: char === ' ' ? 'space' : char });
  };
  return { input, output, editor, history, press, type };
}

beforeEach(() => configureUi({ level: 3, unicode: true }));
afterEach(() => resetUi());

describe('line editor', () => {
  it('edits like readline and submits on Enter', async () => {
    const { editor, press, type, input, output } = setup({ hints: false });
    const result = editor.read();
    type('dcotor');
    press(undefined, { name: 'home' });
    press(undefined, { name: 'right' });
    press(undefined, { name: 'delete' });
    press(undefined, { name: 'delete' });
    type('oc');
    press(undefined, { name: 'end' });
    press('\r', { name: 'return' });
    await expect(result).resolves.toEqual({ type: 'line', line: 'doctor' } satisfies ReadResult);
    expect(input.raw).toEqual([true, false]);
    expect(output.text).toContain('\x1B[?2004h');
    expect(output.text).toContain('\x1B[?2004l');
  });

  it('supports the emacs keys developers expect', async () => {
    const { editor, press, type } = setup({ hints: false });
    const result = editor.read();
    type('api get /transactions');
    press(undefined, { name: 'w', ctrl: true });
    expect(editor.line).toBe('api get /');
    press(undefined, { name: 'a', ctrl: true });
    press(undefined, { name: 'right', meta: true });
    expect(editor.cursor).toBe(3);
    press(undefined, { name: 'k', ctrl: true });
    expect(editor.line).toBe('api');
    press(undefined, { name: 'u', ctrl: true });
    expect(editor.line).toBe('');
    press('\r', { name: 'return' });
    await expect(result).resolves.toEqual({ type: 'line', line: '' });
  });

  it('clears the line on Ctrl+C, and reports an interrupt on an empty one', async () => {
    const { editor, press, type } = setup();
    const first = editor.read();
    type('/doc');
    press(undefined, { name: 'c', ctrl: true });
    expect(editor.line).toBe('');
    press(undefined, { name: 'c', ctrl: true });
    await expect(first).resolves.toEqual({ type: 'interrupt' });
    const second = editor.read();
    press(undefined, { name: 'd', ctrl: true });
    await expect(second).resolves.toEqual({ type: 'eof' });
  });

  it('never runs a pasted newline', async () => {
    const { editor, press } = setup({ hints: false });
    const result = editor.read();
    press(undefined, { name: 'paste-start' });
    for (const char of 'doctor\r--json') press(char, { name: char === '\r' ? 'return' : char });
    press(undefined, { name: 'paste-end' });
    expect(editor.line).toBe('doctor --json');
    press('\r', { name: 'return' });
    await expect(result).resolves.toEqual({ type: 'line', line: 'doctor --json' });
  });

  it('runs the palette pick when Enter lands on a half-typed command', async () => {
    const { editor, press, type } = setup();
    const result = editor.read();
    type('/doc');
    press('\r', { name: 'return' });
    await expect(result).resolves.toEqual({ type: 'line', line: '/doctor' });
  });

  it('runs a complete or group name exactly as typed', async () => {
    const one = setup();
    const r1 = one.editor.read();
    one.type('/api');
    one.press('\r', { name: 'return' });
    await expect(r1).resolves.toEqual({ type: 'line', line: '/api' });

    const two = setup();
    const r2 = two.editor.read();
    two.type('/doctor --json');
    two.press('\r', { name: 'return' });
    await expect(r2).resolves.toEqual({ type: 'line', line: '/doctor --json' });
  });

  it('completes with Tab and moves through the palette with the arrows', async () => {
    const { editor, press, type } = setup();
    const result = editor.read();
    type('/api g');
    press('\t', { name: 'tab' });
    expect(editor.line).toBe('/api get ');
    press(undefined, { name: 'u', ctrl: true });
    type('/watch --cert ');
    press('\t', { name: 'tab' });
    expect(editor.line).toBe('/watch --cert global-core ');
    press(undefined, { name: 'u', ctrl: true });
    type('/');
    press(undefined, { name: 'down' });
    press(undefined, { name: 'down' });
    press('\t', { name: 'tab' });
    expect(editor.line).toBe('/init ');
    press(undefined, { name: 'u', ctrl: true });
    press('\r', { name: 'return' });
    await result;
  });

  it('puts the selection back on the best match whenever the text changes', async () => {
    const { editor, press, type, output } = setup();
    const result = editor.read();
    type('/');
    press(undefined, { name: 'down' });
    press(undefined, { name: 'down' });
    type('th');
    const frame = output.lastFrame().join('\n');
    expect(frame).toMatch(/❯ \/theme/);
    press(undefined, { name: 'u', ctrl: true });
    press('\r', { name: 'return' });
    await result;
  });

  it('treats Esc then Enter typed quickly (Alt+Enter) as close the palette and run', async () => {
    const { editor, press, type } = setup();
    const result = editor.read();
    type('/theme');
    press('\r', { name: 'return', meta: true });
    await expect(result).resolves.toEqual({ type: 'line', line: '/theme' });
  });

  it('closes the palette with Esc until the line changes', async () => {
    const { editor, press, type, output } = setup();
    const result = editor.read();
    type('/');
    expect(output.lastFrame().join('\n')).toContain('/quick-start');
    press(undefined, { name: 'escape', meta: true });
    expect(output.lastFrame().join('\n')).not.toContain('/quick-start');
    type('d');
    expect(output.lastFrame().join('\n')).toContain('/doctor');
    press(undefined, { name: 'u', ctrl: true });
    press('\r', { name: 'return' });
    await result;
  });

  it('walks history with the arrows, filtered by what was typed', async () => {
    const history = new History();
    history.add('/doctor');
    history.add('/watch --cert global-core');
    history.add('/api get /transactions');
    const { editor, press, type } = setup({ history, hints: false });
    const result = editor.read();
    press(undefined, { name: 'up' });
    expect(editor.line).toBe('/api get /transactions');
    press(undefined, { name: 'up' });
    expect(editor.line).toBe('/watch --cert global-core');
    press(undefined, { name: 'down' });
    press(undefined, { name: 'down' });
    expect(editor.line).toBe('');
    type('/d');
    press(undefined, { name: 'up' });
    expect(editor.line).toBe('/doctor');
    press(undefined, { name: 'down' });
    expect(editor.line).toBe('/d');
    press(undefined, { name: 'u', ctrl: true });
    press('\r', { name: 'return' });
    await result;
  });

  it('suggests from history in grey and accepts it with the right arrow', async () => {
    const history = new History();
    history.add('globalpayments-style watch --cert global-core');
    const { editor, press, type, output } = setup({ history });
    const result = editor.read();
    type('globalpayments-style w');
    expect(output.lastFrame()[0]).toContain('globalpayments-style watch --cert global-core');
    press(undefined, { name: 'right' });
    expect(editor.line).toBe('globalpayments-style watch --cert global-core');
    press(undefined, { name: 'u', ctrl: true });
    press('\r', { name: 'return' });
    await result;
  });

  it('shows no grey suggestion without colour, where it would look typed', async () => {
    configureUi({ level: 0, unicode: true });
    const history = new History();
    history.add('/watch --cert global-core');
    const { editor, press, type, output } = setup({ history });
    const result = editor.read();
    type('/wat');
    expect(output.lastFrame()[0]).toBe('> /wat');
    press(undefined, { name: 'u', ctrl: true });
    press('\r', { name: 'return' });
    await result;
  });

  it('keeps every drawn row inside the terminal, even when the line wraps', async () => {
    const { editor, press, type, output } = setup();
    output.columns = 30;
    const result = editor.read();
    type('/api get /transactions?page_size=5&order=DESC&channel=CNP');
    type(' --env-file .env');
    for (const frame of output.text.split('\x1B[?25l').slice(1)) {
      // Row 0 is the input itself, which the terminal wraps; every row drawn under it is cut to fit.
      const [, ...below] = stripAnsi(frame).replace(/^\r/, '').split('\r\n');
      for (const row of below) expect(stringWidth(row), row).toBeLessThan(30);
    }
    press(undefined, { name: 'u', ctrl: true });
    press('\r', { name: 'return' });
    await result;
  });

  it('only auto-runs a confident match on Enter', async () => {
    const { editor, press, type } = setup();
    const result = editor.read();
    type('/snd');
    press('\r', { name: 'return' });
    await expect(result).resolves.toEqual({ type: 'line', line: '/snd' });
  });

  it('moves the cursor to the end before handing over, so output never lands on the command', async () => {
    const { editor, press, type, output } = setup({ hints: false });
    output.columns = 20;
    const result = editor.read();
    type('/api get /transactions?page_size=5');
    press(undefined, { name: 'home' });
    press('\r', { name: 'return' });
    await result;
    const last = output.text.split('\x1B[?25l').pop() ?? '';
    // The final frame leaves the cursor on the last row of the command, not above it.
    expect(last).not.toMatch(/\x1B\[\d+A\x1B\[\d+G\x1B\[\?25h\r\n$/);
    expect(editor.cursor).toBe(editor.line.length);
  });

  it('steps over emoji and wide characters as one', async () => {
    const { editor, press, type } = setup({ hints: false });
    const result = editor.read();
    type('a😀b');
    press(undefined, { name: 'left' });
    press(undefined, { name: 'left' });
    expect(editor.cursor).toBe(1);
    press(undefined, { name: 'delete' });
    expect(editor.line).toBe('ab');
    press(undefined, { name: 'u', ctrl: true });
    press('\r', { name: 'return' });
    await result;
  });

  it('recovers from a paste that never ended', async () => {
    const { editor, press } = setup({ hints: false });
    const first = editor.read();
    press(undefined, { name: 'paste-start' });
    press(undefined, { name: 'c', ctrl: true });
    editor.cancel();
    await first;
    const second = editor.read();
    press('x', { name: 'x' });
    press('\r', { name: 'return' });
    await expect(second).resolves.toEqual({ type: 'line', line: 'x' });
  });

  it('ignores keys after the line is submitted', async () => {
    const { editor, press } = setup();
    const result = editor.read();
    press('\r', { name: 'return' });
    await result;
    const spy = vi.spyOn(editor, 'render');
    press('x', { name: 'x' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('layout', () => {
  it('wraps a wide character that does not fit in the last column', () => {
    expect(layout('abc', 10)).toEqual({ row: 0, col: 3 });
    expect(layout('abcdefghij', 10)).toEqual({ row: 0, col: 10 });
    expect(layout('abcdefghijk', 10)).toEqual({ row: 1, col: 1 });
    expect(layout('abcdefghi支', 10)).toEqual({ row: 1, col: 2 });
    expect(layout('e\u0301', 10)).toEqual({ row: 0, col: 1 });
  });
});
