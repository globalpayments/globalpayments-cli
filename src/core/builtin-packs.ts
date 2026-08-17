import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the absolute path to the bundled packs directory shipped inside
 * the @globalpayments/cli package.
 *
 * tsup bundles all source into a single dist/bin.js, so at runtime this
 * module's import.meta.url points at dist/bin.js itself, not its original
 * src/core/ location — packs/ ends up a sibling of that file (dist/packs),
 * not one directory up. In-source (tsx / vitest) contexts are unbundled, so
 * this module keeps its real src/core/ location and packs/ is one directory
 * up (src/packs). Try the bundled layout first, fall back to the in-source one.
 */
export function resolveBuiltinPacksDir(): string {
  const anchor = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(anchor);
  const bundledCandidate = path.resolve(moduleDir, 'packs');
  if (existsSync(bundledCandidate)) {
    return bundledCandidate;
  }
  return path.resolve(moduleDir, '..', 'packs');
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
