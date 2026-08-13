import { describe, expect, it } from 'vitest';
import { redactObject } from '../src/core/redaction.js';

describe('redaction', () => {
  it('redacts sensitive auth keys and tokens', () => {
    const input = {
      appId: 'app-id',
      appKey: 'super-secret',
      token: 'abc',
      nested: {
        secret: 'value',
        keep: 'ok'
      }
    };

    const output = redactObject(input);

    expect(output.appId).toBe('app-id');
    expect(output.appKey).toBe('[REDACTED]');
    expect(output.token).toBe('[REDACTED]');
    expect((output.nested as Record<string, unknown>).secret).toBe('[REDACTED]');
    expect((output.nested as Record<string, unknown>).keep).toBe('ok');
  });

  it('redacts case-insensitive secret keys and nested arrays', () => {
    const input = {
      AppKey: 'mixed-case-secret',
      nested: {
        ACCESS_TOKEN: 'token-value'
      },
      list: [
        { authorization: 'Bearer abc' },
        { safe: 'value' }
      ]
    };

    const output = redactObject(input);

    expect(output.AppKey).toBe('[REDACTED]');
    expect((output.nested as Record<string, unknown>).ACCESS_TOKEN).toBe('[REDACTED]');

    const items = output.list as Array<Record<string, unknown>>;
    expect(items[0]?.authorization).toBe('[REDACTED]');
    expect(items[1]?.safe).toBe('value');
  });
});
