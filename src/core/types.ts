/**
 * Matching-layer types.
 *
 * This module deliberately owns *only* the vocabulary that is specific to matching.
 * Everything else is re-exported from `src/types/domain.ts`, which is the single
 * definition of the domain. Previously this file re-declared `MatchCriteria`,
 * `ObservedTxn` and `CertificationCase` with subtly different shapes, so the same
 * type name meant two different things depending on the import path.
 */
import type { MatchCriteria, ObservedTxn } from '../types/domain.js';

export type { MatchCriteria, ObservedTxn, TransactionRecord } from '../types/domain.js';

/**
 * The narrow structural view of a case that the matcher requires.
 *
 * A full `CertificationCase` from the domain satisfies this, but the matcher never
 * needs expectations or metadata. Narrowing the input keeps the matcher independently
 * testable and makes its real dependency explicit.
 */
export interface MatchableCase {
  id: string;
  matcher: MatchCriteria;
}

export type MatchStrategy = 'exact-reference' | 'reference-prefix' | 'composite';

export interface MatchResult {
  caseId: string;
  strategy?: MatchStrategy;
  candidates: ObservedTxn[];
  latest?: ObservedTxn;
  ambiguous: boolean;
}
