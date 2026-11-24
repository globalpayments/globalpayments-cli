import { describe, expect, it } from 'vitest';
import { parseStatusFilter } from '../src/commands/logs.js';

describe('request log status filter', () => {
  it.each(['4xx', '5xx', '400', '599'])('accepts %s', (value) => {
    expect(parseStatusFilter(value)).toBe(value);
  });

  it.each(['099', '600', '4x', ''])('rejects %s', (value) => {
    expect(() => parseStatusFilter(value)).toThrow();
  });
});
