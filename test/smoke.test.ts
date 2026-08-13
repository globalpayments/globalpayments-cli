import { describe, expect, it } from 'vitest';
import { buildCli } from '../src/index.js';

describe('cli smoke', () => {
  it('renders help with required command surface', () => {
    const help = buildCli().helpInformation();

    expect(help).toContain('Global Payments certification observer CLI');
    expect(help).toContain('init');
    expect(help).toContain('doctor');
    expect(help).toContain('auth');
    expect(help).toContain('watch');
    expect(help).toContain('run');
    expect(help).toContain('report');
    expect(help).toContain('cases');
  });
});
