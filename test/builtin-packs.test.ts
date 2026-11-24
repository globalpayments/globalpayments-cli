import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { listBuiltinPackIds, resolveBuiltinPacksDir } from '../src/core/builtin-packs.js';
import { loadCaseFile } from '../src/config/load.js';
import { matchesCriteria } from '../src/core/matching.js';

describe('builtin-packs', () => {
  it('finds the bundled cert packs shipped with the CLI', async () => {
    const packs = await listBuiltinPackIds();
    expect(packs).toEqual(expect.arrayContaining(['global-core', 'global-ecommerce']));
  });

  it('matches the core sale case in EUR and USD without accepting other transaction types', async () => {
    const caze = await loadCaseFile(path.join(resolveBuiltinPacksDir(), 'global-core', 'cases', 'basic-sale.yaml'));
    const sale = { id: 'test', timeCreated: '2026-01-01T00:00:00Z', type: 'SALE', channel: 'CNP' };

    expect(matchesCriteria({ ...sale, currency: 'EUR' }, caze.matcher)).toBe(true);
    expect(matchesCriteria({ ...sale, currency: 'USD' }, caze.matcher)).toBe(true);
    expect(matchesCriteria({ ...sale, currency: 'EUR', type: 'REFUND' }, caze.matcher)).toBe(false);
  });
});
