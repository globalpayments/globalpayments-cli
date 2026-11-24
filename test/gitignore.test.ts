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
});
