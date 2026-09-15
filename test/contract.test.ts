import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { buildCli } from '../src/index.js';
import { buildEnvelope } from '../src/contract/envelope.js';
import { emit, runCommand } from '../src/contract/emit.js';
import {
  ERROR_CODES,
  ERROR_CODE_EXIT,
  ERROR_CODE_REMEDIATION,
  GlobalPaymentsError,
  toGlobalPaymentsError,
  type ErrorCode
} from '../src/contract/errors.js';
import { EXIT_CODES, exitCodeName } from '../src/contract/exit-codes.js';
import { buildManifest } from '../src/contract/manifest.js';
import { CLI_VERSION } from '../src/contract/version.js';
import { ConfigLoadError } from '../src/config/load.js';
import { InvalidCredentialsError, NetworkAuthError, MalformedAuthResponseError } from '../src/gpapi/auth.js';

function captureStream(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    }
  });
  return { stream: stream as unknown as NodeJS.WritableStream, text: () => chunks.join('') };
}

describe('contract: envelope invariant', () => {
  it('reports ok exactly when the exit code is zero', () => {
    const success = buildEnvelope({ command: 'x' });
    expect(success.ok).toBe(true);
    expect(success.exitCode).toBe(EXIT_CODES.OK);

    const failure = buildEnvelope({
      command: 'x',
      error: new GlobalPaymentsError(ERROR_CODES.E_NETWORK, 'down')
    });
    expect(failure.ok).toBe(false);
    expect(failure.exitCode).toBe(EXIT_CODES.NETWORK);
  });

  it('refuses to build an envelope that would break the invariant', () => {
    expect(() => buildEnvelope({ command: 'x', exitCode: EXIT_CODES.NETWORK })).toThrow(/invariant/);
  });

  it('omits empty optional collections rather than emitting noise', () => {
    const envelope = buildEnvelope({ command: 'x', warnings: [], nextActions: [] });
    expect(envelope).not.toHaveProperty('warnings');
    expect(envelope).not.toHaveProperty('nextActions');
  });
});

describe('contract: json mode purity', () => {
  it('writes exactly one JSON document to stdout and nothing to stderr', () => {
    const out = captureStream();
    const err = captureStream();

    emit(
      'demo',
      { data: { value: 1 }, render: () => { throw new Error('render must not run in json mode'); } },
      { json: true, stdout: out.stream, stderr: err.stream }
    );

    expect(err.text()).toBe('');
    const parsed = JSON.parse(out.text());
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ value: 1 });
    expect(out.text().trimEnd().split('\n').filter((l) => l === '}')).toHaveLength(1);
  });

  it('keeps stdout clean when a command fails in json mode', () => {
    const out = captureStream();
    const err = captureStream();

    emit(
      'demo',
      { error: new GlobalPaymentsError(ERROR_CODES.E_PACK_NOT_FOUND, 'nope') },
      { json: true, stdout: out.stream, stderr: err.stream }
    );

    expect(err.text()).toBe('');
    const parsed = JSON.parse(out.text());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('E_PACK_NOT_FOUND');
    expect(parsed.error.remediation).toBeTruthy();
  });

  it('renders data before the error in text mode so a failed run still shows its summary', () => {
    const out = captureStream();
    const err = captureStream();
    const rendered: string[] = [];

    emit(
      'demo',
      {
        data: { value: 1 },
        render: () => rendered.push('summary'),
        error: new GlobalPaymentsError(ERROR_CODES.E_CERT_REQUIRED_CASES_FAILING, 'failing')
      },
      { json: false, stdout: out.stream, stderr: err.stream }
    );

    expect(rendered).toEqual(['summary']);
    expect(err.text()).toContain('E_CERT_REQUIRED_CASES_FAILING');
  });
});

describe('contract: runCommand normalizes every failure', () => {
  it('classifies an unknown throw as an internal error', async () => {
    const out = captureStream();
    const envelope = await runCommand(
      'demo',
      { json: true, stdout: out.stream, stderr: captureStream().stream },
      async () => {
        throw new Error('boom');
      }
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('E_INTERNAL');
    expect(envelope.exitCode).toBe(EXIT_CODES.INTERNAL);
    expect(envelope.nextActions?.length).toBeGreaterThan(0);
  });

  it('always attaches at least one recovery action to a failure', async () => {
    for (const code of Object.values(ERROR_CODES)) {
      const out = captureStream();
      const envelope = await runCommand(
        'demo',
        { json: true, stdout: out.stream, stderr: captureStream().stream },
        async () => {
          throw new GlobalPaymentsError(code, 'x');
        }
      );
      expect(envelope.nextActions, `missing nextActions for ${code}`).toBeDefined();
      expect(envelope.nextActions!.length).toBeGreaterThan(0);
    }
  });
});

describe('contract: error taxonomy', () => {
  it('maps every internal error type onto a stable code and distinct exit class', () => {
    expect(toGlobalPaymentsError(new ConfigLoadError('read-failed', 'p', 'm')).code).toBe('E_CONFIG_READ');
    expect(toGlobalPaymentsError(new ConfigLoadError('yaml-parse', 'p', 'm')).code).toBe('E_CONFIG_PARSE');
    expect(toGlobalPaymentsError(new ConfigLoadError('schema-invalid', 'p', 'm')).code).toBe('E_CONFIG_INVALID');
    expect(toGlobalPaymentsError(new InvalidCredentialsError('bad', 401)).code).toBe('E_AUTH_INVALID_CREDENTIALS');
    expect(toGlobalPaymentsError(new NetworkAuthError('offline')).code).toBe('E_NETWORK');
    expect(toGlobalPaymentsError(new MalformedAuthResponseError('weird')).code).toBe('E_AUTH_MALFORMED_RESPONSE');
    expect(toGlobalPaymentsError(new Error('Pack "x" not found. Searched: /a')).code).toBe('E_PACK_NOT_FOUND');
    expect(toGlobalPaymentsError(new Error('Parent pack not found: base')).code).toBe('E_PACK_NOT_FOUND');
  });

  it('is idempotent so wrapping never loses classification', () => {
    const original = new GlobalPaymentsError(ERROR_CODES.E_NETWORK, 'down');
    expect(toGlobalPaymentsError(original)).toBe(original);
  });

  it('gives every error code an exit code and a remediation', () => {
    for (const code of Object.values(ERROR_CODES) as ErrorCode[]) {
      expect(ERROR_CODE_EXIT[code], `no exit code for ${code}`).toBeTypeOf('number');
      expect(ERROR_CODE_REMEDIATION[code]?.length, `no remediation for ${code}`).toBeGreaterThan(10);
    }
  });

  it('distinguishes a certification failure from a tool failure by exit code', () => {
    expect(ERROR_CODE_EXIT.E_CERT_REQUIRED_CASES_FAILING).toBe(EXIT_CODES.CERT_FAILED);
    expect(ERROR_CODE_EXIT.E_INTERNAL).not.toBe(EXIT_CODES.CERT_FAILED);
  });

  it('names exit codes for diagnostics', () => {
    expect(exitCodeName(4)).toBe('AUTH');
    expect(exitCodeName(99)).toBe('UNKNOWN');
  });
});

describe('contract: manifest', () => {
  const manifest = buildManifest(buildCli());

  it('describes every registered leaf command and no namespaces', () => {
    const ids = manifest.commands.map((c) => c.id).sort();
    expect(ids).toEqual(
      [
        'auth.test',
        'cases.list',
        'cases.show',
        'diagnose',
        'doctor',
        'explain',
        'init',
        'packs.list',
        'packs.show',
        'report',
        'run',
        'watch'
      ].sort()
    );
  });

  it('offers --json on every command so no output path is human-only', () => {
    const withoutJson = manifest.commands.filter((c) => !c.supportsJson).map((c) => c.id);
    expect(withoutJson).toEqual([]);
  });

  it('documents each command and its usage', () => {
    for (const command of manifest.commands) {
      expect(command.description.length, `${command.id} has no description`).toBeGreaterThan(10);
      expect(command.usage.startsWith('globalpayments ')).toBe(true);
    }
  });

  it('publishes the exit and error taxonomies in full', () => {
    expect(manifest.exitCodes).toHaveLength(Object.keys(EXIT_CODES).length);
    expect(manifest.errorCodes).toHaveLength(Object.keys(ERROR_CODES).length);
    expect(manifest.exitCodes.find((e) => e.name === 'NETWORK')?.retryable).toBe(true);
    expect(manifest.exitCodes.find((e) => e.name === 'CONFIG')?.retryable).toBe(false);
  });

  it('names both required credentials in the environment contract', () => {
    const required = manifest.environment.filter((v) => v.required).map((v) => v.name);
    expect(required).toEqual(['GP_API_APP_ID', 'GP_API_APP_KEY']);
  });

  it('provides workflows whose steps are literal globalpayments invocations', () => {
    expect(manifest.workflows.length).toBeGreaterThan(0);
    for (const workflow of manifest.workflows) {
      expect(workflow.steps.length).toBeGreaterThan(0);
      for (const step of workflow.steps) {
        expect(step.command.startsWith('globalpayments ')).toBe(true);
      }
    }
  });

  it('stays in lockstep with the published package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(CLI_VERSION).toBe(pkg.version);
  });
});
