import { loadObserverConfig } from '../config/load.js';
import { loadPackGraph } from './pack-loader.js';
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
 * Add pack namespace prefix to case IDs for uniqueness across multiple packs.
 * Transforms case.id from "case-id" to "pack-id:case-id".
 */
function namespaceCases(packId: string, cases: CertificationCase[]): CertificationCase[] {
  return cases.map((c) => {
    // Extract raw case ID in case it's already namespaced (shouldn't happen in normal flow)
    const rawId = c.id.includes(':') ? (c.id.split(':')[1] ?? c.id) : c.id;
    return {
      ...c,
      id: `${packId}:${rawId}`
    };
  });
}

/**
 * Resolve a pack's full inheritance chain and produce final executable pack.
 * - Merges all inherited cases (child overrides parent)
 * - Merges metadata and tags (child over parent)
 * - Namespaces case IDs to prevent conflicts across packs
 *
 * Note: This function works with the raw (unnamespaced) pack graph from loadPackGraph.
 * It builds the case inheritance chain and only namespaces at the end.
 */
export function resolveInheritedPack(packId: string, graph: Map<string, CertificationPack>): CertificationPack {
  const current = graph.get(packId);
  if (!current) {
    throw new Error(`Pack not found: ${packId}`);
  }

  // Recursively build the parent packs, but keep their case IDs unnamespaced internally
  const resolvedParents = (current.extends ?? []).map((parentId) => {
    // Get parent from graph and extract raw cases
    const parentPack = graph.get(parentId);
    if (!parentPack) {
      throw new Error(`Parent pack not found: ${parentId}`);
    }
    const resolved = resolveInheritedPackInternal(parentId, graph);
    return resolved;
  });

  // Build case map: parent cases → child overrides
  // Match by raw case ID (without pack namespace)
  const inheritedCases = resolvedParents
    .flatMap((parentPack) => parentPack.cases)
    .reduce<Map<string, CertificationCase>>((acc, caze) => {
      // Extract raw case ID
      const rawId = caze.id.includes(':') ? (caze.id.split(':')[1] ?? caze.id) : caze.id;
      acc.set(rawId, caze);
      return acc;
    }, new Map());

  // Child cases override parent cases by raw id
  for (const caze of current.cases) {
    inheritedCases.set(caze.id, caze);
  }

  return {
    ...current,
    metadata: mergePackMetadata(current, resolvedParents),
    tags: mergePackTags(current, resolvedParents),
    cases: namespaceCases(current.id, Array.from(inheritedCases.values()))
  };
}

/**
 * Internal helper for recursive pack resolution that keeps cases unnamespaced
 * until the final top-level pack is resolved.
 */
function resolveInheritedPackInternal(
  packId: string,
  graph: Map<string, CertificationPack>
): CertificationPack {
  const current = graph.get(packId);
  if (!current) {
    throw new Error(`Pack not found: ${packId}`);
  }

  const resolvedParents = (current.extends ?? []).map((parentId) => {
    return resolveInheritedPackInternal(parentId, graph);
  });

  // Build case map: parent cases → child overrides
  const inheritedCases = resolvedParents
    .flatMap((parentPack) => parentPack.cases)
    .reduce<Map<string, CertificationCase>>((acc, caze) => {
      acc.set(caze.id, caze);
      return acc;
    }, new Map());

  // Child cases override parent cases by id
  for (const caze of current.cases) {
    inheritedCases.set(caze.id, caze);
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
