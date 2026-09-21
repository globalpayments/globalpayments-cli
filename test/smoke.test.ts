import { describe, expect, it } from 'vitest';
import { buildCli } from '../src/index.js';

describe('cli smoke', () => {
  it('exposes the full command surface in help', () => {
    const help = buildCli().helpInformation();

    for (const command of ['explain', 'init', 'doctor', 'auth', 'packs', 'cases', 'run', 'watch', 'report']) {
      expect(help).toContain(command);
    }
  });

  it('describes itself as an observer so callers do not expect it to create transactions', () => {
    expect(buildCli().description()).toMatch(/observer-only/i);
  });
});
