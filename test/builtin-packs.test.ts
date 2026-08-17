import { describe, expect, it } from 'vitest';
import { listBuiltinPackIds } from '../src/core/builtin-packs.js';

describe('builtin-packs', () => {
  it('finds the bundled cert packs shipped with the CLI', async () => {
    const packs = await listBuiltinPackIds();
    expect(packs).toEqual(expect.arrayContaining(['global-core', 'global-ecommerce']));
  });
});
