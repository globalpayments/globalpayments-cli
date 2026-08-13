export interface MatchCriteria {
  reference?: string;
  referencePrefix?: string;
  type?: string;
  amount?: number;
  currency?: string;
  channel?: string;
  accountName?: string;
  cardBrand?: string;
  last4?: string;
}

export interface CertificationCase {
  id: string;
  matcher: MatchCriteria;
}

export interface ObservedTxn {
  id: string;
  timeCreated: string;
  accountName?: string;
  reference?: string;
  type?: string;
  channel?: string;
  status?: string;
  amount?: number;
  currency?: string;
  cardBrand?: string;
  last4?: string;
}

export type MatchStrategy = 'exact-reference' | 'reference-prefix' | 'composite';

export interface MatchResult {
  caseId: string;
  strategy?: MatchStrategy;
  candidates: ObservedTxn[];
  latest?: ObservedTxn;
  ambiguous: boolean;
}
