import { loadObserverConfig } from '../config/load.js';
import { loadPackGraph } from './pack-loader.js';
import { localCaseId } from './ids.js';
import type { CertificationCase, CertificationPack, ObserverConfig } from '../types/domain.js';

/**
 * Resolve the active profile from CLI override or config default.
 */
export function resolveProfile(config: ObserverConfig, profile?: string): string | undefined {
  if (!profile) {
    return config.activeProfile;
  }

  return profile;
}

/**
 * Merge active packs from multiple sources:
 * 1. config.activePacks (defined in config file)
 * 2. profile packs (from --profile or activeProfile)
 * 3. CLI --pack flags
 *
 * Returns deduplicated list preserving order: config → profile → cli.
 */
export function resolveActivePacks(config: ObserverConfig, cliPacks: string[], profile?: string): string[] {
  const resolvedProfile = resolveProfile(config, profile);
  const fromProfile = resolvedProfile ? (config.profiles?.[resolvedProfile]?.packs ?? []) : [];
  const fromConfig = config.activePacks ?? [];
  return Array.from(new Set([...fromConfig, ...fromProfile, ...cliPacks]));
}

/**
 * Merge metadata from a pack and its parents.
 * Child pack metadata takes precedence over parent metadata (shallow merge).
 */
function mergePackMetadata(
  pack: CertificationPack,
  parents: CertificationPack[]
): CertificationPack['metadata'] {
  // Start with all parent metadata (grandparent → parent → ...)
  const merged = parents.reduce<CertificationPack['metadata']>(
    (acc, parent) => ({ ...acc, ...parent.metadata }),
    {}
  );
  // Child overrides all parent values
  return { ...merged, ...pack.metadata };
}

/**
 * Merge tags from a pack and its parents.
 * Returns a deduped set of all tags from child and ancestors.
 */
function mergePackTags(pack: CertificationPack, parents: CertificationPack[]): string[] | undefined {
  const merged = new Set<string>();
  for (const parent of parents) {
    for (const tag of parent.tags ?? []) {
      merged.add(tag);
    }
  }
  for (const tag of pack.tags ?? []) {
    merged.add(tag);
  }
  return merged.size > 0 ? Array.from(merged) : undefined;
}

/**
 * Resolve a pack's full inheritance chain into a final, executable pack.
 *
 * - Merges inherited cases, child overriding parent by local case id
 * - Merges metadata and tags, child over parent
 *
 * Case ids are left in their local form (`basic-sale-approved`). The globally unique
 * address (`global-core:basic-sale-approved`) is derived on demand via
 * {@link caseAddress}; see `src/core/ids.ts` for why the two are kept distinct.
 */
export function resolveInheritedPack(packId: string, graph: Map<string, CertificationPack>): CertificationPack {
  return resolveInheritedPackWithSeen(packId, graph, new Set());
}

function resolveInheritedPackWithSeen(
  packId: string,
  graph: Map<string, CertificationPack>,
  seen: Set<string>
): CertificationPack {
  const current = graph.get(packId);
  if (!current) {
    throw new Error(`Pack not found: ${packId}`);
  }

  if (seen.has(packId)) {
    throw new Error(`Circular pack inheritance detected at "${packId}": ${[...seen, packId].join(' -> ')}`);
  }
  const nextSeen = new Set(seen).add(packId);

  const resolvedParents = (current.extends ?? []).map((parentId) =>
    resolveInheritedPackWithSeen(parentId, graph, nextSeen)
  );

  // Parent cases first, then child cases override them by local id.
  const inheritedCases = new Map<string, CertificationCase>();
  for (const parent of resolvedParents) {
    for (const caze of parent.cases) {
      inheritedCases.set(localCaseId(caze.id), caze);
    }
  }
  for (const caze of current.cases) {
    inheritedCases.set(localCaseId(caze.id), caze);
  }

  return {
    ...current,
    metadata: mergePackMetadata(current, resolvedParents),
    tags: mergePackTags(current, resolvedParents),
    cases: Array.from(inheritedCases.values())
  };
}

/**
 * Load and resolve all active packs into executable pack list.
 * Returns packs with fully inherited and namespaced cases ready for evaluation.
 */
export async function loadFromConfig(
  configPath: string,
  cliPacks: string[],
  profile?: string
): Promise<CertificationPack[]> {
  const config = await loadObserverConfig(configPath);
  const active = resolveActivePacks(config, cliPacks, profile);
  const graph = await loadPackGraph(config.packs?.directory, active);
  return active.map((packId) => resolveInheritedPack(packId, graph));
}
