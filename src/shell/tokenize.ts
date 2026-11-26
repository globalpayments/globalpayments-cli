/**
 * Split a shell line into arguments the way a POSIX shell would for the common
 * cases: whitespace separates, single quotes are literal, double quotes allow
 * backslash escapes, and a backslash outside quotes escapes the next character.
 * There is no expansion of any kind ($VAR, globs, ~), so what is typed is what
 * the command receives.
 */
export interface TokenizeResult {
  args: string[];
  /** Set when the line ends inside a quote. */
  error?: string;
}

export function tokenize(line: string, platform: NodeJS.Platform = process.platform): TokenizeResult {
  const args: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = undefined;
      } else if (char === '\\' && index + 1 < line.length && ['"', '\\', '$', '`'].includes(line[index + 1]!)) {
        current += line[index + 1]!;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
      continue;
    }
    // On Windows a backslash is a path separator (C:\Users\me), so it only escapes a quote.
    if (char === '\\' && index + 1 < line.length && (platform !== 'win32' || line[index + 1] === '"' || line[index + 1] === "'")) {
      current += line[index + 1]!;
      inToken = true;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        args.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += char;
    inToken = true;
  }

  if (quote) {
    return { args: inToken ? [...args, current] : args, error: `Unclosed ${quote === '"' ? 'double' : 'single'} quote.` };
  }
  if (inToken) args.push(current);
  return { args };
}

/** Quote an argument for display or for re-insertion into a line, only when it needs it. */
export function quoteArg(value: string): string {
  if (value === '') return "''";
  if (/^[\w@%+=:,./?&-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The token under the cursor: where it starts, and the text before the cursor.
 * Quotes are tracked so a space inside quotes does not start a new token.
 */
export function currentToken(line: string, cursor: number): { start: number; text: string; index: number } {
  let start = 0;
  let index = 0;
  let quote: string | undefined;
  let sawContent = false;
  for (let i = 0; i < cursor; i += 1) {
    const char = line[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      sawContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (sawContent) index += 1;
      sawContent = false;
      start = i + 1;
      continue;
    }
    sawContent = true;
  }
  return { start, text: line.slice(start, cursor), index };
}
