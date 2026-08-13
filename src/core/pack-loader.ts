import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadCaseFile, loadPackManifest, resolvePackCasesDir, resolvePackPath } from '../config/load.js';
import type { CertificationPack } from '../types/domain.js';
import { resolveBuiltinPacksDir } from './builtin-packs.js';

/**
 * Resolve the directory that contains a given pack ID.
 * Checks the bundled (builtin) packs first, then falls back to the user-supplied
 * packs directory.  Returns undefined if the pack cannot be found in either location.
 */
function resolvePackDir(packId: string, userPacksDir?: string): string | undefined {
  const builtinDir = path.join(resolveBuiltinPacksDir(), packId);
  if (existsSync(path.join(builtinDir, 'pack.yaml'))) {
    return resolveBuiltinPacksDir();
  }
  if (userPacksDir) {
    const userDir = path.join(userPacksDir, packId);
    if (existsSync(path.join(userDir, 'pack.yaml'))) {
      return userPacksDir;
    }
  }
  return undefined;
}

/**
 * Load a single pack manifest and all its cases from the filesystem.
 * Searches builtin packs first, then the optional user packs directory.
 */
export async function loadPackById(packsDir: string | undefined, packId: string): Promise<CertificationPack> {
  const resolvedDir = resolvePackDir(packId, packsDir);
  if (!resolvedDir) {
    const locations = [resolveBuiltinPacksDir(), ...(packsDir ? [packsDir] : [])].join(', ');
    throw new Error(`Pack "${packId}" not found. Searched: ${locations}`);
  }

  const manifestPath = resolvePackPath(resolvedDir, packId);
  const manifest = await loadPackManifest(manifestPath);
  const casesDir = resolvePackCasesDir(resolvedDir, packId, manifest.casesDirectory);
  const entries = await readdir(casesDir);
  const caseFiles = entries.filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'));
  const cases = await Promise.all(caseFiles.map((name) => loadCaseFile(path.join(casesDir, name))));

  return {
    ...manifest,
    cases
  };
}

/**
 * Recursively load a pack and all its parent packs into a dependency graph.
 * The graph includes all packs needed to resolve inheritance chains.
 */
export async function loadPackGraph(packsDir: string | undefined, rootPackIds: string[]): Promise<Map<string, CertificationPack>> {
  const loaded = new Map<string, CertificationPack>();

  async function loadRec(packId: string): Promise<void> {
    if (loaded.has(packId)) {
      return;
    }

    const pack = await loadPackById(packsDir, packId);
    loaded.set(packId, pack);

    for (const parent of pack.extends ?? []) {
      await loadRec(parent);
    }
  }

  for (const packId of rootPackIds) {
    await loadRec(packId);
  }

  return loaded;
}
