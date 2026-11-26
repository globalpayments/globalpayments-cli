import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTutorial } from '../src/commands/quick-start.js';

describe('quick-start tutorial', () => {
  it('explains the workflow without running anything when every action is declined', async () => {
    const say = vi.fn();
    const run = vi.fn();
    const checkSandbox = vi.fn();
    const exit = await runTutorial({ say, confirm: async () => false, run, checkSandbox });
    expect(exit).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(checkSandbox).not.toHaveBeenCalled();
    const text = say.mock.calls.map(([line]) => line).join('\n');
    expect(text).toContain('developer.globalpayments.com');
    expect(text).toContain('never creates or captures a payment');
    expect(text).toContain('globalpayments diagnose');
  });

  it('opens with the plain ASCII banner, uncoloured', async () => {
    const saved = { columns: process.stdout.columns, rows: process.stdout.rows };
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true, writable: true });
    try {
      const lines: string[] = [];
      await runTutorial({ say: (line) => lines.push(line), confirm: async () => false, run: vi.fn(), checkSandbox: vi.fn() });
      const tagline = lines.findIndex((line) => line.includes('DEVELOPER CLI'));
      expect(lines[0]).toBe('');
      expect(tagline).toBe(6);
      for (const line of lines.slice(1, tagline + 1)) expect(line).not.toContain('\x1B');
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: saved.columns, configurable: true, writable: true });
      Object.defineProperty(process.stdout, 'rows', { value: saved.rows, configurable: true, writable: true });
    }
  });

  it('runs only confirmed actions and checks sandbox before network requests', async () => {
    const events: string[] = [];
    const answers = [true, true, true, true, true];
    const exit = await runTutorial({
      say: () => {},
      confirm: async () => answers.shift() ?? false,
      checkSandbox: async () => { events.push('sandbox-check'); },
      run: async (args) => { events.push(args.join(' ')); return 0; }
    });
    expect(exit).toBe(0);
    expect(events).toEqual([
      'sandbox create',
      'sandbox-check', 'doctor',
      'cases list --cert global-core',
      'sandbox-check', 'api get /transactions?page_size=5',
      'sandbox-check', 'watch --cert global-core --timeout 5m'
    ]);
  });

  it('stops before a network step if sandbox validation fails', async () => {
    const run = vi.fn();
    const confirms = [false, true];
    await expect(runTutorial({
      say: () => {},
      confirm: async () => confirms.shift() ?? false,
      checkSandbox: async () => { throw new Error('not sandbox'); },
      run
    })).rejects.toThrow('not sandbox');
    expect(run).not.toHaveBeenCalled();
  });

  it('surfaces a pending watch as a nonzero result and still explains diagnosis', async () => {
    const confirms = [false, false, false, false, true];
    const say = vi.fn();
    const exit = await runTutorial({
      say,
      confirm: async () => confirms.shift() ?? false,
      checkSandbox: async () => {},
      run: async () => 1
    });
    expect(exit).toBe(1);
    expect(say.mock.calls.map(([line]) => line).join('\n')).toContain('globalpayments diagnose');
  });

  it('does not continue when a chosen command fails', async () => {
    const run = vi.fn(async () => 4);
    await expect(runTutorial({
      say: () => {},
      confirm: async () => true,
      checkSandbox: async () => {},
      run
    })).rejects.toMatchObject({ code: 'E_AUTH_FAILED', exitCode: 4 });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs a selected offline step from the interactive source CLI', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gp-quick-start-'));
    try {
      const preloader = path.join(root, 'tty.cjs');
      await writeFile(preloader, `
        Object.defineProperty(process.stdin, 'isTTY', { value: true });
        Object.defineProperty(process.stdout, 'isTTY', { value: true });
        process.stdin.setRawMode = function (value) { this.isRaw = value; return this; };
      `);
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
      for (const key of Object.keys(env)) if (key.startsWith('GP_API_')) delete env[key];
      const child = spawn(process.execPath, [
        '--require', preloader, '--import', tsx, path.resolve('src', 'bin.ts'), 'quick-start'
      ], { cwd: root, env });
      const answers = ['invalid', 'n', 'n', 'y', 'n', 'n'];
      let output = '';
      let answered = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const promptCount = (output.match(/\[y\/N\]/g) ?? []).length;
        if (promptCount > answered && answered < answers.length) {
          child.stdin.write(`${answers[answered++]}\n`);
        }
      });
      let errors = '';
      child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
      const exit = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('Interactive tutorial timed out')); }, 15_000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('close', (code) => { clearTimeout(timer); resolve(code); });
      });
      expect(exit, errors).toBe(0);
      expect(answered).toBe(6);
      expect(output).toContain('Please enter y or n.');
      expect(output).toContain('global-core:basic-sale-approved');

      const interrupted = spawn(process.execPath, [
        '--require', preloader, '--import', tsx, path.resolve('src', 'bin.ts'), 'quick-start'
      ], { cwd: root, env });
      let interruptedOutput = '';
      interrupted.stdout.on('data', (chunk: Buffer) => {
        interruptedOutput += chunk.toString();
        if (interruptedOutput.includes('[y/N]')) interrupted.stdin.end();
      });
      interrupted.stderr.on('data', (chunk: Buffer) => { interruptedOutput += chunk.toString(); });
      const interruptedExit = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { interrupted.kill(); reject(new Error('Interrupted tutorial timed out')); }, 15_000);
        interrupted.once('error', (error) => { clearTimeout(timer); reject(error); });
        interrupted.once('close', (code) => { clearTimeout(timer); resolve(code); });
      });
      expect(interruptedExit).toBe(2);
      expect(interruptedOutput).toContain('Quick-start was interrupted');

      const production = spawn(process.execPath, [
        '--require', preloader, '--import', tsx, path.resolve('src', 'bin.ts'), 'quick-start'
      ], { cwd: root, env: { ...env, GP_API_ENVIRONMENT: 'production' } });
      let productionOutput = '';
      let productionAnswers = 0;
      production.stdout.on('data', (chunk: Buffer) => {
        productionOutput += chunk.toString();
        if ((productionOutput.match(/\[y\/N\]/g) ?? []).length > productionAnswers) {
          production.stdin.write(`${['n', 'y'][productionAnswers++]}\n`);
        }
      });
      production.stderr.on('data', (chunk: Buffer) => { productionOutput += chunk.toString(); });
      const productionExit = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => { production.kill(); reject(new Error('Sandbox check timed out')); }, 15_000);
        production.once('error', (error) => { clearTimeout(timer); reject(error); });
        production.once('close', (code) => { clearTimeout(timer); resolve(code); });
      });
      expect(productionExit).toBe(3);
      expect(productionOutput).toContain('Quick-start network steps require the resolved environment to be sandbox');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
