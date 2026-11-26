/**
 * What the terminal on the other end can do.
 *
 * The rules follow the conventions developers already rely on, in priority order:
 * `--no-color` / `--color` on the command line, then NO_COLOR (https://no-color.org),
 * then FORCE_COLOR, then whether stdout is a terminal at all, then TERM=dumb, then
 * what the terminal advertises about itself. Output that goes to a pipe or a file
 * never carries escape codes unless the caller forces them.
 */

export type ColorLevel = 0 | 1 | 2 | 3;

export interface CapabilityInput {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  isTTY?: boolean;
  platform?: NodeJS.Platform;
}

function flagIn(argv: string[], flag: string): boolean {
  const terminator = argv.indexOf('--');
  return (terminator === -1 ? argv : argv.slice(0, terminator)).includes(flag);
}

export function detectColorLevel(input: CapabilityInput = {}): ColorLevel {
  const env = input.env ?? process.env;
  const argv = input.argv ?? process.argv;
  const isTTY = input.isTTY ?? Boolean(process.stdout.isTTY);

  if (flagIn(argv, '--no-color')) return 0;
  const forcedByFlag = flagIn(argv, '--color');

  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '' && !forcedByFlag) return 0;

  let forced: ColorLevel | undefined = forcedByFlag ? 1 : undefined;
  const force = env.FORCE_COLOR;
  if (force !== undefined && !forcedByFlag) {
    if (force === '0' || force.toLowerCase() === 'false') return 0;
    forced = force === '2' ? 2 : force === '3' ? 3 : 1;
  }

  if (!isTTY && forced === undefined) return 0;
  if (env.TERM === 'dumb' && forced === undefined) return 0;

  const detected = detectTerminalLevel(env, input.platform ?? process.platform);
  if (forced === undefined) return detected;
  // Forced colour on a real terminal can still use what the terminal supports;
  // forced colour into a pipe uses exactly the level that was asked for.
  return isTTY ? (Math.max(forced, detected) as ColorLevel) : forced;
}

function detectTerminalLevel(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ColorLevel {
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  if (env.WT_SESSION) return 3;
  switch (env.TERM_PROGRAM) {
    case 'iTerm.app':
    case 'vscode':
    case 'WezTerm':
    case 'ghostty':
    case 'Hyper':
    case 'Tabby':
    case 'rio':
      return 3;
    case 'Apple_Terminal':
      return 2;
    default:
      break;
  }
  const term = (env.TERM ?? '').toLowerCase();
  if (term.includes('truecolor') || term.includes('direct') || term === 'xterm-kitty' || term === 'xterm-ghostty' || term === 'alacritty') return 3;
  if (term.includes('256')) return 2;
  if (platform === 'win32') return 3;
  return 1;
}

/**
 * Whether box-drawing and symbol glyphs will render. Windows consoles outside
 * Windows Terminal and the Linux virtual console are the usual holdouts.
 */
export function detectUnicode(input: CapabilityInput = {}): boolean {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  if (env.TERM === 'linux') return false;
  if (platform !== 'win32') {
    const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
    // An explicit non-UTF locale ("C", "POSIX", "en_US.ISO-8859-1") opts out.
    return !locale || /utf-?8/i.test(locale);
  }
  return Boolean(
    env.WT_SESSION ||
      env.TERMINUS_SUBLIME ||
      env.ConEmuTask === '{cmd::Cmder}' ||
      env.TERM_PROGRAM === 'vscode' ||
      env.TERM === 'xterm-256color' ||
      env.TERM === 'alacritty'
  );
}

/** Columns available on stdout, falling back to $COLUMNS and then 80. */
export function terminalColumns(stream: { columns?: number } = process.stdout, env: NodeJS.ProcessEnv = process.env): number {
  if (stream.columns && stream.columns > 0) return stream.columns;
  const fromEnv = Number.parseInt(env.COLUMNS ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 80;
}

export function terminalRows(stream: { rows?: number } = process.stdout, env: NodeJS.ProcessEnv = process.env): number {
  if (stream.rows && stream.rows > 0) return stream.rows;
  const fromEnv = Number.parseInt(env.LINES ?? '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 24;
}

/** True when a person is at the keyboard: both ends are terminals and this is not CI. */
export function isInteractive(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  if (env.CI && env.CI !== 'false' && env.CI !== '0') return false;
  if (env.TERM === 'dumb') return false;
  return true;
}

/**
 * Light or dark background, from COLORFGBG ("fg;bg") when the terminal exports it.
 * Returns undefined when the terminal does not say.
 */
export function detectBackground(env: NodeJS.ProcessEnv = process.env): 'light' | 'dark' | undefined {
  const value = env.COLORFGBG;
  if (!value) return undefined;
  const parts = value.split(';');
  const bg = Number.parseInt(parts[parts.length - 1] ?? '', 10);
  if (!Number.isFinite(bg)) return undefined;
  return bg === 7 || bg === 15 ? 'light' : 'dark';
}
