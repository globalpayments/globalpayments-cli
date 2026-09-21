import type { CertificationCase, TransactionRecord } from '../types/domain.js';

export type DetailRowStatus = 'matched' | 'changed' | 'missing' | 'unavailable';

export interface DetailValueRow {
  label: string;
  value: unknown;
}

export interface DetailComparisonRow {
  label: string;
  expected: unknown;
  actual: unknown;
  status: DetailRowStatus;
}

export interface CaseDetail {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'pending';
  reason: string;
  scenario: string;
  expectedValues: DetailValueRow[];
  sentValues: DetailValueRow[];
  comparisons: DetailComparisonRow[];
}

interface CaseStateLike {
  namespacedCaseId?: string;
  namespacedId?: string;
  status: 'pass' | 'fail' | 'pending';
  reason: string;
  latestMatch?: TransactionRecord;
  matchedCount: number;
}

function namespacedIdFor(caze: CertificationCase, state: CaseStateLike): string {
  return state.namespacedId ?? state.namespacedCaseId ?? caze.id;
}

function pushIfDefined(rows: DetailValueRow[], label: string, value: unknown): void {
  if (value !== undefined) {
    rows.push({ label, value });
  }
}

function expectedRows(caze: CertificationCase): DetailValueRow[] {
  const rows: DetailValueRow[] = [];
  pushIfDefined(rows, 'reference', caze.matcher.reference);
  pushIfDefined(rows, 'reference prefix', caze.matcher.referencePrefix);
  pushIfDefined(rows, 'type', caze.matcher.type);
  pushIfDefined(rows, 'channel', caze.matcher.channel);
  pushIfDefined(rows, 'amount', caze.matcher.amount);
  pushIfDefined(rows, 'currency', caze.matcher.currency);
  pushIfDefined(rows, 'account name', caze.matcher.accountName);
  pushIfDefined(rows, 'card brand', caze.matcher.cardBrand);
  pushIfDefined(rows, 'last4', caze.matcher.last4);
  pushIfDefined(rows, 'status in', caze.expect.latest?.statusIn);
  pushIfDefined(rows, 'response code in', caze.expect.latest?.responseCodeIn);
  pushIfDefined(rows, 'status sequence', caze.expect.sequence?.statusInOrder);
  pushIfDefined(rows, 'minimum matches', caze.expect.aggregate?.minMatches);
  return rows;
}

function sentRows(latest: TransactionRecord | undefined): DetailValueRow[] {
  if (!latest) {
    return [];
  }

  const rows: DetailValueRow[] = [];
  pushIfDefined(rows, 'id', latest.id);
  pushIfDefined(rows, 'reference', latest.reference);
  pushIfDefined(rows, 'type', latest.type);
  pushIfDefined(rows, 'channel', latest.channel);
  pushIfDefined(rows, 'amount', latest.amount);
  pushIfDefined(rows, 'currency', latest.currency);
  pushIfDefined(rows, 'status', latest.status);
  pushIfDefined(rows, 'response code', latest.responseCode);
  pushIfDefined(rows, 'account name', latest.accountName);
  pushIfDefined(rows, 'card brand', latest.cardBrand ?? latest.paymentMethod?.cardBrand);
  pushIfDefined(rows, 'last4', latest.last4 ?? latest.paymentMethod?.last4);
  return rows;
}

function compareScalar(label: string, expected: unknown, actual: unknown): DetailComparisonRow | undefined {
  if (expected === undefined) {
    return undefined;
  }
  if (actual === undefined) {
    return { label, expected, actual, status: 'missing' };
  }
  return { label, expected, actual, status: Object.is(expected, actual) ? 'matched' : 'changed' };
}

function compareInList(label: string, expected: string[] | undefined, actual: string | undefined): DetailComparisonRow | undefined {
  if (!expected) {
    return undefined;
  }
  if (actual === undefined) {
    return { label, expected, actual, status: 'unavailable' };
  }
  return { label, expected, actual, status: expected.includes(actual) ? 'matched' : 'changed' };
}

function compareReferencePrefix(expected: string | undefined, actual: string | undefined): DetailComparisonRow | undefined {
  if (!expected) {
    return undefined;
  }
  if (actual === undefined) {
    return { label: 'reference prefix', expected, actual, status: 'missing' };
  }
  return { label: 'reference prefix', expected, actual, status: actual.startsWith(expected) ? 'matched' : 'changed' };
}

function comparisonRows(caze: CertificationCase, latest: TransactionRecord | undefined): DetailComparisonRow[] {
  if (!latest) {
    return [];
  }

  return [
    compareScalar('reference', caze.matcher.reference, latest.reference),
    compareReferencePrefix(caze.matcher.referencePrefix, latest.reference),
    compareScalar('type', caze.matcher.type, latest.type),
    compareScalar('channel', caze.matcher.channel, latest.channel),
    compareScalar('amount', caze.matcher.amount, latest.amount),
    compareScalar('currency', caze.matcher.currency, latest.currency),
    compareScalar('account name', caze.matcher.accountName, latest.accountName),
    compareScalar('card brand', caze.matcher.cardBrand, latest.cardBrand ?? latest.paymentMethod?.cardBrand),
    compareScalar('last4', caze.matcher.last4, latest.last4 ?? latest.paymentMethod?.last4),
    compareInList('status', caze.expect.latest?.statusIn, latest.status),
    compareInList('response code', caze.expect.latest?.responseCodeIn, latest.responseCode)
  ].filter((row): row is DetailComparisonRow => row !== undefined);
}

export function buildCaseDetail(caze: CertificationCase, state: CaseStateLike): CaseDetail {
  const scenario = caze.scenario ?? caze.name;
  const latestMatch = state.latestMatch;

  return {
    id: namespacedIdFor(caze, state),
    name: caze.name,
    status: state.status,
    reason: state.reason,
    scenario,
    expectedValues: expectedRows(caze),
    sentValues: sentRows(latestMatch),
    comparisons: comparisonRows(caze, latestMatch)
  };
}
