import { describe, expect, it } from 'vitest';
import { mergeGitignore } from '../src/io/gitignore.js';

describe('gitignore setup', () => {
  it('preserves existing rules and adds missing local secret/install paths once', () => {
    const existing = 'node_modules/\r\n.env\r\n.globalpayments/\r\n';
    expect(mergeGitignore(existing, ['.env', '.globalpayments/agent/'])).toBe(existing);

    const first = mergeGitignore('node_modules/\r\n', ['.env', '.globalpayments/agent/']);
    expect(first).toBe('node_modules/\r\n\r\n.env\r\n.globalpayments/agent/\r\n');
    expect(mergeGitignore(first, ['.env', '.globalpayments/agent/'])).toBe(first);
  });

  it('does not count a directory-only rule or a re-included file as ignoring .env', () => {
    expect(mergeGitignore('.env/\n', ['.env'])).toBe('.env/\n\n.env\n');
    expect(mergeGitignore('.env\n!.env\n', ['.env'])).toBe('.env\n!.env\n\n.env\n');
    expect(mergeGitignore('!.env\n.env\n', ['.env'])).toBe('!.env\n.env\n');
    expect(mergeGitignore('config/\n', ['config/.env'])).toBe('config/\n');
    expect(mergeGitignore('/.globalpayments/agent/\n', ['/.globalpayments/agent/'])).toBe('/.globalpayments/agent/\n');
    expect(mergeGitignore('# .env\n', ['.env'])).toBe('# .env\n\n.env\n');
  });
});
