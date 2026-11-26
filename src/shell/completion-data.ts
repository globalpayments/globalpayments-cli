import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { listBuiltinPackIds, resolveBuiltinPacksDir } from '../core/builtin-packs.js';

/**
 * Pack ids and case addresses for completion, read straight from the bundled
 * pack files. No credentials, no network, no environment loading: completion
 * runs on every Tab press and must be fast and side-effect free.
 */
export async function loadCompletionData(): Promise<{ packIds: string[]; caseAddresses: string[] }> {
  const packIds = await listBuiltinPackIds().catch(() => [] as string[]);
  const root = resolveBuiltinPacksDir();
  const caseAddresses: string[] = [];
  await Promise.all(
    packIds.map(async (packId) => {
      let files: string[];
      try {
        files = await readdir(path.join(root, packId, 'cases'));
      } catch {
        return;
      }
      for (const file of files.filter((name) => /\.ya?ml$/.test(name)).sort()) {
        try {
          const parsed = parseYaml(await readFile(path.join(root, packId, 'cases', file), 'utf8')) as { id?: unknown };
          if (typeof parsed?.id === 'string') caseAddresses.push(`${packId}:${parsed.id}`);
        } catch {
          // A malformed case file is reported by the commands that load it, not here.
        }
      }
    })
  );
  return { packIds, caseAddresses: caseAddresses.sort() };
}
