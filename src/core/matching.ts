import type { MatchCriteria, MatchResult, MatchStrategy, MatchableCase, ObservedTxn } from './types.js';

function matchField(value: string | number | undefined, expected: string | number | undefined): boolean {
  return expected === undefined || value === expected;
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortByNewest<T extends ObservedTxn>(transactions: T[]): T[] {
  return [...transactions].sort((a, b) => parseTime(b.timeCreated) - parseTime(a.timeCreated));
}

function matchesBaseComposite(txn: ObservedTxn, criteria: MatchCriteria): boolean {
  return (
    matchField(txn.type, criteria.type) &&
    matchField(txn.amount, criteria.amount) &&
    matchField(txn.currency, criteria.currency) &&
    matchField(txn.channel, criteria.channel) &&
    matchField(txn.accountName, criteria.accountName)
  );
}

function matchesOptionalCardFilters(txn: ObservedTxn, criteria: MatchCriteria): boolean {
  return matchField(txn.cardBrand, criteria.cardBrand) && matchField(txn.last4, criteria.last4);
}

function matchesByStrategy(txn: ObservedTxn, criteria: MatchCriteria, strategy: MatchStrategy): boolean {
  if (!matchesBaseComposite(txn, criteria) || !matchesOptionalCardFilters(txn, criteria)) {
    return false;
  }

  if (strategy === 'exact-reference') {
    return matchField(txn.reference, criteria.reference);
  }

  if (strategy === 'reference-prefix') {
    const prefix = criteria.referencePrefix;
    return prefix !== undefined && (txn.reference ?? '').startsWith(prefix);
  }

  return true;
}

export function selectLatestCandidate<T extends ObservedTxn>(candidates: T[]): T | undefined {
  return sortByNewest(candidates)[0];
}

export function detectAmbiguousMatches<T extends ObservedTxn>(candidates: T[]): boolean {
  if (candidates.length <= 1) {
    return false;
  }

  const sorted = sortByNewest(candidates);
  const latest = sorted[0];
  const secondLatest = sorted[1];

  if (!latest || !secondLatest) {
    return false;
  }

  return parseTime(latest.timeCreated) === parseTime(secondLatest.timeCreated);
}

export function matchCaseToTransactions<TTxn extends ObservedTxn, TCase extends MatchableCase>(
  transactions: TTxn[],
  caze: TCase
): MatchResult & { candidates: TTxn[]; latest?: TTxn } {
  const { matcher } = caze;
  const hasExactReference = matcher.reference !== undefined;
  const hasReferencePrefix = matcher.referencePrefix !== undefined;

  const strategies: MatchStrategy[] = hasExactReference
    ? ['exact-reference', 'reference-prefix', 'composite']
    : hasReferencePrefix
      ? ['reference-prefix', 'composite']
      : ['composite'];

  for (const strategy of strategies) {
    const candidates = sortByNewest(transactions.filter((txn) => matchesByStrategy(txn, matcher, strategy)));
    if (candidates.length === 0) {
      continue;
    }

    return {
      caseId: caze.id,
      strategy,
      candidates,
      latest: candidates[0],
      ambiguous: detectAmbiguousMatches(candidates)
    };
  }

  return {
    caseId: caze.id,
    strategy: undefined,
    candidates: [],
    latest: undefined,
    ambiguous: false
  };
}

export function matchesCriteria(txn: ObservedTxn, criteria: MatchCriteria): boolean {
  return matchesByStrategy(txn, criteria, 'composite');
}

export function findMatches<TTxn extends ObservedTxn, TCase extends MatchableCase>(transactions: TTxn[], caze: TCase): TTxn[] {
  return matchCaseToTransactions(transactions, caze).candidates;
}

export function latestMatch<T extends ObservedTxn>(matches: T[]): T | undefined {
  return selectLatestCandidate(matches);
}
