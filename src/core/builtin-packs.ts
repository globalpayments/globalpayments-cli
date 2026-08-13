import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the absolute path to the bundled packs directory shipped inside
 * the @globalpayments/cli package.  Works both in the built dist/ tree and
 * in-source (tsx / vitest) contexts.
 *
 * Layout:
 *   dist/
 *     bin.js          ← __filename / import.meta.url anchor
 *     packs/          ← bundled packs (copied by tsup)
 *       global-core/
 *       ...
 */
export function resolveBuiltinPacksDir(): string {
  const anchor = fileURLToPath(import.meta.url);
  const distDir = path.dirname(anchor);
  // Works whether this module lives at dist/core/builtin-packs.js or src/core/builtin-packs.ts
  const candidate = path.resolve(distDir, '..', 'packs');
  return candidate;
}

/**
 * List all pack IDs available in the bundled packs directory.
 * Returns an empty array if the directory does not exist.
 */
export async function listBuiltinPackIds(): Promise<string[]> {
  const dir = resolveBuiltinPacksDir();
  if (!existsSync(dir)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}
