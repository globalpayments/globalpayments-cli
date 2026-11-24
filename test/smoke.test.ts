import { describe, expect, it, vi } from 'vitest';
import { buildCli } from '../src/index.js';
import { runCli } from '../src/cli.js';

describe('cli smoke', () => {
  it('exposes the full command surface in help', () => {
    const help = buildCli().helpInformation();

    for (const command of [
      'explain',
      'init',
      'doctor',
      'auth',
      'sandbox',
      'api',
      'transactions',
      'logs',
      'listen',
      'trigger',
      'agent',
      'packs',
      'cases',
      'run',
      'watch',
      'report'
    ]) {
      expect(help).toContain(command);
    }
  });

  it('describes the expanded developer tooling surface', () => {
    expect(buildCli().description()).toMatch(/sandbox API access/i);
  });

  it('lets a completed command exit naturally with its envelope status', async () => {
    const previousExitCode = process.exitCode;
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('forced exit');
    });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runCli(['node', 'globalpayments', 'cases', 'show', 'global-core:basic-sale-approved', '--json']);
      expect(exit).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
      write.mockRestore();
      exit.mockRestore();
    }
  });
});
