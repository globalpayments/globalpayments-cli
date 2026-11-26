import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCli } from '../src/cli.js';
import { Catalog, editDistance, matchScore } from '../src/shell/catalog.js';
import { History, isSensitive } from '../src/shell/history.js';
import { currentToken, quoteArg, tokenize } from '../src/shell/tokenize.js';
import { maskId, parseDotEnv, readShellStatus } from '../src/shell/status.js';

const catalog = new Catalog(buildCli(), {
  packIds: () => ['global-core', 'global-ecommerce'],
  caseAddresses: () => ['global-core:basic-sale-approved', 'global-ecommerce:3ds-challenge'],
  cwd: () => path.resolve('test/fixtures')
});

function values(line: string, cursor = line.length): string[] {
  return catalog.suggest(line, cursor)?.items.map((item) => item.value) ?? [];
}

describe('tokenize', () => {
  it('splits like a shell, without expanding anything', () => {
    expect(tokenize('api get /transactions?page_size=5').args).toEqual(['api', 'get', '/transactions?page_size=5']);
    expect(tokenize(`api post /x --data '{"a": 1}'`).args).toEqual(['api', 'post', '/x', '--data', '{"a": 1}']);
    expect(tokenize('say "a \\"b\\" $HOME"').args).toEqual(['say', 'a "b" $HOME']);
    expect(tokenize('a\\ b c').args).toEqual(['a b', 'c']);
    expect(tokenize("x ''").args).toEqual(['x', '']);
    expect(tokenize('  ').args).toEqual([]);
  });

  it('reports an unclosed quote', () => {
    expect(tokenize(`--data '{"a"`).error).toMatch(/single quote/);
    expect(tokenize('"abc').error).toMatch(/double quote/);
  });

  it('finds the token under the cursor', () => {
    expect(currentToken('api ge', 6)).toEqual({ start: 4, text: 'ge', index: 1 });
    expect(currentToken('api ', 4)).toEqual({ start: 4, text: '', index: 1 });
    expect(currentToken(`x "a b`, 6)).toEqual({ start: 2, text: '"a b', index: 1 });
  });

  it('keeps Windows paths intact', () => {
    expect(tokenize('api post /x --data-file C:\\Users\\me\\b.json', 'win32').args).toEqual(['api', 'post', '/x', '--data-file', 'C:\\Users\\me\\b.json']);
    expect(tokenize('say \\"hi\\"', 'win32').args).toEqual(['say', '"hi"']);
    expect(tokenize('a\\ b', 'linux').args).toEqual(['a b']);
  });

  it('quotes only when needed', () => {
    expect(quoteArg('global-core:basic-sale-approved')).toBe('global-core:basic-sale-approved');
    expect(quoteArg('my file.json')).toBe(`'my file.json'`);
    expect(quoteArg("it's")).toBe(`'it'\\''s'`);
  });
});

describe('catalog', () => {
  it('ranks the obvious command first', () => {
    expect(values('/doc')[0]).toBe('doctor');
    expect(values('/he')[0]).toBe('help');
    expect(values('/ex')[0]).toBe('exit');
    expect(values('/diag')[0]).toBe('diagnose');
    expect(values('/')[0]).toBe('quick-start');
    expect(values('/')).not.toContain('shell');
    expect(values('/')).toContain('api get');
  });

  it('walks into groups', () => {
    expect(values('/api ')).toEqual(['get', 'post']);
    expect(values('/transactions t')[0]).toBe('testpay');
    expect(catalog.suggest('/api ', 5)?.title).toBe('/api <command>');
  });

  it('completes options, without repeating ones already used', () => {
    const options = values('/doctor --');
    expect(options).toEqual(expect.arrayContaining(['--config', '--env-file', '--json', '--help']));
    expect(values('/doctor --json --')).not.toContain('--json');
    expect(values('/cases list --pack global-core --')).toContain('--pack');
  });

  it('completes values for options and arguments', () => {
    expect(values('/watch --cert ')).toEqual(['global-core', 'global-ecommerce']);
    expect(values('/watch --cert eco')).toEqual(['global-ecommerce']);
    expect(values('/cases show ')).toContain('global-core:basic-sale-approved');
    expect(values('/diagnose 3ds')).toEqual(['global-ecommerce:3ds-challenge']);
    expect(values('/trigger ')).toContain('transaction.captured');
    expect(values('/ui set ')).toEqual(['theme', 'banner', 'icons', 'motion', 'hints']);
    expect(values('/completion ')).toEqual(['bash', 'zsh', 'fish']);
    expect(values('/agent setup --editor ')).toEqual(['claude-code', 'cursor', 'vscode']);
    expect(values('/theme ')).toEqual(['auto', 'gp', 'gp-light', 'classic', 'mono']);
    expect(values('/help ap')).toEqual(['api']);
  });

  it('works without the slash too', () => {
    expect(values('doc')[0]).toBe('doctor');
    expect(values('api ')).toEqual(['get', 'post']);
  });

  it('offers no values for free-form arguments, only the usage', () => {
    const set = catalog.suggest('/api get ', 9);
    expect(set?.items).toEqual([]);
    expect(set?.title).toBe('/api get <path>');
  });

  it('suggests close matches for typos', () => {
    expect(catalog.didYouMean('hlep')).toContain('help');
    expect(catalog.didYouMean('doctr')[0]).toBe('doctor');
    expect(catalog.didYouMean('zzzzzzzz')).toEqual([]);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(matchScore('doctor', 'doc')).toBeGreaterThan(matchScore('docs-and-more', 'doc'));
    expect(matchScore('transactions get', 'get')).toBeGreaterThan(0);
    expect(matchScore('doctor', 'xyz')).toBe(0);
  });
});

describe('history', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('persists commands, skips repeats, and never writes secrets or card numbers', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gp-history-'));
    const file = path.join(dir, 'history');
    const history = new History(file);
    history.add('/doctor');
    history.add('/doctor');
    history.add(`/api post /transactions --data '{"card":{"number":"4263970000005262"}}'`);
    history.add('/api get /transactions?card=4263 9700 0000 5262');
    history.add('GP_API_APP_KEY=abc /doctor');
    history.add('/watch --cert global-core');
    expect(history.all()).toHaveLength(5);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toEqual(['/doctor', '/watch --cert global-core']);
    expect(new History(file).all()).toEqual(['/doctor', '/watch --cert global-core']);
  });

  it('suggests the latest entry that extends what was typed', () => {
    const history = new History();
    history.add('/watch --cert global-core');
    history.add('/watch --cert global-ecommerce');
    expect(history.suggest('/wat')).toBe('/watch --cert global-ecommerce');
    expect(history.suggest('/watch --cert global-c')).toBe('/watch --cert global-core');
    expect(history.suggest('')).toBeUndefined();
    expect(history.suggest('/watch --cert global-ecommerce')).toBeUndefined();
  });

  it('flags sensitive lines', () => {
    expect(isSensitive('/api post /x --data {}')).toBe(true);
    expect(isSensitive('/sandbox create --app-key abc')).toBe(true);
    expect(isSensitive('/api get /transactions/TRN_6891a7a8971d4cb7884e2e360c0b03a9')).toBe(false);
    expect(isSensitive('/doctor')).toBe(false);
    expect(isSensitive('/api get /transactions?ref=card_4111111111111111')).toBe(true);
    expect(isSensitive('UJqPrAhrDkGzzNoFInpzKqoI8vfZtGRV')).toBe(true);
    expect(isSensitive('/transactions get TRN_6891a7a8971d4cb7884e2e360c0b03a9Ab')).toBe(false);
    expect(isSensitive('/cases show global-ecommerce:sale-delayed-capture-auth')).toBe(false);
  });
});

describe('status', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('parses .env files the usual way', () => {
    expect(
      parseDotEnv(['# comment', 'export GP_API_APP_ID=abc', 'GP_API_APP_KEY="k#ey"', "GP_API_ENVIRONMENT='production'", 'X=1 # note', 'bad line'].join('\n'))
    ).toEqual({ GP_API_APP_ID: 'abc', GP_API_APP_KEY: 'k#ey', GP_API_ENVIRONMENT: 'production', X: '1' });
  });

  it('masks ids', () => {
    expect(maskId('UJqPrAhrDkGzzNoFInpzKqoI8vfZtGRV')).toBe('UJqP…GRV');
    expect(maskId('short')).toBe('sh…');
  });

  it('reads .env without touching the process environment', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gp-status-'));
    const before = { ...process.env };
    expect((await readShellStatus(dir, {})).source).toBe('none');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dir, '.env'), 'GP_API_APP_ID=appid1234567\nGP_API_APP_KEY=secret\n');
    const sandbox = await readShellStatus(dir, {});
    expect(sandbox).toMatchObject({ environment: 'sandbox', source: '.env', hasKey: true, appId: 'appi…567', envFile: '.env' });
    const production = await readShellStatus(dir, { GP_API_ENVIRONMENT: 'production', GP_API_APP_ID: 'fromshell999' });
    expect(production).toMatchObject({ environment: 'production', source: 'environment', appId: 'from…999' });
    expect(process.env).toEqual(before);
  });
});
