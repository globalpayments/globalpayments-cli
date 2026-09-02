import { readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the packs directory shipped inside the @globalpayments/cli package.
 *
 * The anchor (`import.meta.url`) lands in a different place depending on how the
 * code is executed, so a single hard-coded `..` is wrong half the time:
 *
 *   in-source (tsx / vitest)   anchor = src/core/builtin-packs.ts  -> ../packs = src/packs
 *   bundled   (tsup -> dist)   anchor = dist/bin.js (inlined)      -> ./packs  = dist/packs
 *
 * Rather than guess which context we are in, probe both candidates in priority
 * order and take the first that actually exists. This keeps the built binary and
 * the dev loop resolving to the same logical directory.
 */
const PACKS_DIR_CANDIDATES = ['packs', path.join('..', 'packs')];

export function resolveBuiltinPacksDir(): string {
  const anchorDir = path.dirname(fileURLToPath(import.meta.url));

  for (const relative of PACKS_DIR_CANDIDATES) {
    const candidate = path.resolve(anchorDir, relative);
    if (isDirectory(candidate)) {
      return candidate;
    }
  }

  // Nothing exists. Return the conventional location so error messages point
  // somewhere meaningful rather than at an empty string.
  return path.resolve(anchorDir, PACKS_DIR_CANDIDATES[0]!);
}

/**
 * True when the bundled packs directory is present. A `false` here means the
 * installed package is incomplete (a build/packaging fault), not a user error.
 */
export function builtinPacksDirExists(): boolean {
  return isDirectory(resolveBuiltinPacksDir());
}

/**
 * List every pack id in the bundled packs directory, sorted for deterministic
 * output. Returns an empty array when the directory is missing; callers that
 * must distinguish "missing" from "empty" should consult builtinPacksDirExists().
 */
export async function listBuiltinPackIds(): Promise<string[]> {
  const dir = resolveBuiltinPacksDir();
  if (!isDirectory(dir)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function isDirectory(candidate: string): boolean {
  if (!existsSync(candidate)) {
    return false;
  }
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
