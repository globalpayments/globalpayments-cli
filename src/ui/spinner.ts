import { truncate } from './ansi.js';
import { terminalColumns } from './capabilities.js';
import { motionEnabled, sym, t } from './index.js';

export interface SpinnerOptions {
  /** Never draw anything (JSON mode). */
  silent?: boolean;
  stream?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  /** Wait this long before drawing, so fast calls never flicker. */
  delayMs?: number;
}

const HIDE_CURSOR = '\x1B[?25l';
const SHOW_CURSOR = '\x1B[?25h';
const CLEAR_LINE = '\r\x1B[2K';

let cursorHidden = false;
let exitHookInstalled = false;

function restoreCursor(stream: NodeJS.WriteStream): void {
  if (cursorHidden) {
    stream.write(SHOW_CURSOR);
    cursorHidden = false;
  }
}

function installExitHook(stream: NodeJS.WriteStream): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // A spinner must never leave the cursor hidden, even when the process dies under it.
  process.once('exit', () => restoreCursor(stream));
}

/**
 * Run a slow task behind a one-line spinner on stderr.
 *
 * Draws only when stderr is a terminal outside CI and not in JSON mode, so piped
 * output, logs and agents never see it. The line is cleared before the task's
 * result is printed. With motion off the line is drawn once, without animation.
 */
export async function withSpinner<T>(label: string, task: () => Promise<T>, options: SpinnerOptions = {}): Promise<T> {
  const stream = options.stream ?? process.stderr;
  const env = options.env ?? process.env;
  const inCi = Boolean(env.CI && env.CI !== 'false' && env.CI !== '0');
  if (options.silent || !stream.isTTY || inCi || env.TERM === 'dumb') {
    return task();
  }

  const frames = sym().spinner;
  const animate = motionEnabled();
  let frame = 0;
  let drawn = false;
  let timer: NodeJS.Timeout | undefined;

  const draw = (): void => {
    const columns = terminalColumns(stream, env);
    const glyph = animate ? frames[frame % frames.length]! : sym().ellipsis;
    stream.write(`${CLEAR_LINE}${t.accent(glyph)} ${truncate(t.muted(label), Math.max(10, columns - 3))}`);
    frame += 1;
    drawn = true;
  };

  // Ctrl+C kills the process without an 'exit' event, so put the cursor back on the
  // signal too, then let the signal do what it would have done.
  const onSignal = (signal: NodeJS.Signals): void => {
    stream.write(CLEAR_LINE);
    restoreCursor(stream);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };

  const start = setTimeout(() => {
    installExitHook(stream);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    stream.write(HIDE_CURSOR);
    cursorHidden = true;
    draw();
    if (animate) timer = setInterval(draw, 90);
  }, options.delayMs ?? 120);

  try {
    return await task();
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    clearTimeout(start);
    if (timer) clearInterval(timer);
    if (drawn) stream.write(CLEAR_LINE);
    restoreCursor(stream);
  }
}
