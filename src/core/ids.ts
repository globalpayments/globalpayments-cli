/**
 * Canonical identity for certification cases.
 *
 * A case has two distinct identities, and conflating them is what produced the
 * historical `pack:pack:case` defect:
 *
 *   - **local id**   — `basic-sale-approved`. The case's own name, unique within its
 *                      pack. This is what lives in the YAML `id:` field and it is
 *                      never rewritten.
 *   - **address**    — `global-core:basic-sale-approved`. The case's globally unique
 *                      location in a run, valid only in the context of a pack.
 *
 * The address is *derived*, never stored. Every component that needs one calls
 * {@link caseAddress}. There is exactly one place in this codebase that concatenates
 * a pack id and a case id, and it is here.
 */

/** Separator between the pack namespace and the local case id. */
export const ID_SEPARATOR = ':';

/**
 * Build the globally unique address of a case.
 *
 * Idempotent: passing an already-addressed case id returns it unchanged, so callers
 * that receive user input do not need to know whether it was already qualified.
 */
export function caseAddress(packId: string, caseId: string): string {
  const local = localCaseId(caseId);
  return `${packId}${ID_SEPARATOR}${local}`;
}

/** Strip any pack namespace, yielding the case's own local id. */
export function localCaseId(caseId: string): string {
  const separatorIndex = caseId.indexOf(ID_SEPARATOR);
  if (separatorIndex === -1) {
    return caseId;
  }
  return caseId.slice(separatorIndex + 1);
}

/** Extract the pack namespace from an address, or undefined if unqualified. */
export function packIdOf(caseAddressOrId: string): string | undefined {
  const separatorIndex = caseAddressOrId.indexOf(ID_SEPARATOR);
  if (separatorIndex === -1) {
    return undefined;
  }
  return caseAddressOrId.slice(0, separatorIndex);
}

export interface ParsedCaseAddress {
  packId: string;
  caseId: string;
  address: string;
}

/**
 * Parse a user-supplied `<packId>:<caseId>` address.
 * Returns undefined when the input is not fully qualified, so callers can produce a
 * precise usage error rather than guessing.
 */
export function parseCaseAddress(input: string): ParsedCaseAddress | undefined {
  const packId = packIdOf(input);
  if (!packId) {
    return undefined;
  }
  const caseId = localCaseId(input);
  if (!caseId) {
    return undefined;
  }
  return { packId, caseId, address: caseAddress(packId, caseId) };
}

/** True when the string is already a fully qualified case address. */
export function isCaseAddress(input: string): boolean {
  return parseCaseAddress(input) !== undefined;
}
