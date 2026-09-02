export type Environment = 'sandbox' | 'production';

export type PollOrder = 'ASC' | 'DESC';

export interface PollWindow {
  fromTimeCreated: string;
  toTimeCreated: string;
  pageSize: number;
  order: PollOrder;
  page: number;
}

export interface ObservedTxnPaymentMethod {
  entryMode?: string;
  cardBrand?: string;
  last4?: string;
  authCode?: string;
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
  responseCode?: string;
  responseMessage?: string;
  paymentMethod?: ObservedTxnPaymentMethod;
  raw?: unknown;

  // Backward-compatible aliases for matcher/evaluator code that still reads top-level values.
  cardBrand?: string;
  last4?: string;
  authCode?: string;
}

export type TransactionRecord = ObservedTxn;

export interface MatchCriteria {
  reference?: string;
  referencePrefix?: string;
  type?: string;
  channel?: string;
  currency?: string;
  amount?: number;
  accountName?: string;
  cardBrand?: string;
  last4?: string;
}

export interface CaseLatestExpectation {
  statusIn?: string[];
  responseCodeIn?: string[];
  [key: string]: unknown;
}

export interface CaseSequenceExpectation {
  statusInOrder?: string[];
  [key: string]: unknown;
}

export interface CaseAggregateExpectation {
  minMatches?: number;
  [key: string]: unknown;
}

export interface CaseExpect {
  latest?: CaseLatestExpectation;
  sequence?: CaseSequenceExpectation;
  aggregate?: CaseAggregateExpectation;
  [key: string]: unknown;
}

export type CaseMode = 'latest' | 'sequence' | 'aggregate';

export interface CaseEvaluatorConfig {
  type: 'declarative' | 'script';
  script?: string;
  export?: string;
}

export interface CertificationCase {
  id: string;
  name: string;
  scenario?: string;
  required: boolean;
  tags?: string[];
  mode?: CaseMode;
  /** Form question number this case satisfies on the GP Integration Validation Form. */
  formQuestion?: number;
  /** How this case is observed: polling = automated via /transactions, manual = requires human verification, partial = polling captures pass/fail but not all signal. */
  observability?: 'polling' | 'manual' | 'partial';
  matcher: MatchCriteria;
  expect: CaseExpect;
  evaluator?: CaseEvaluatorConfig;
}

export interface PackMetadata {
  region?: string;
  industry?: string;
  channel?: string;
}

export interface PackEvaluators {
  default?: string;
  overrides?: Record<string, string>;
}

export interface PackFilters {
  accountName?: string;
  channel?: string;
}

export interface CertificationPack {
  id: string;
  name: string;
  version: string;
  extends?: string[];
  metadata?: PackMetadata;
  tags?: string[];
  casesDirectory: string;
  evaluators?: PackEvaluators;
  filters?: PackFilters;
  cases: CertificationCase[];
}

export interface ProfileConfig {
  packs: string[];
}

export interface AuthConfig {
  mode: 'app-credentials';
  appId: string;
  appKey: string;
  apiVersion: string;
}

export interface AccountConfig {
  accountName?: string;
}

export interface PollingConfig {
  intervalMs: number;
  lookbackMinutes: number;
  overlapSeconds: number;
  pageSize: number;
  order: PollOrder;
}

export interface MatchingConfig {
  defaultStrategy: string;
  requireReference: boolean;
  timeSkewSeconds: number;
}

export interface OutputConfig {
  format: string;
  saveJson: boolean;
  saveJUnit: boolean;
}

export interface PacksConfig {
  directory?: string;
}

export interface ObserverConfig {
  version: number;
  environment: Environment;
  auth: AuthConfig;
  account: AccountConfig;
  polling: PollingConfig;
  matching: MatchingConfig;
  output: OutputConfig;
  packs: PacksConfig;
  activePacks?: string[];
  profiles?: Record<string, ProfileConfig>;
  activeProfile?: string;
}

export interface ResolvedObserverConfig extends ObserverConfig {
  configPath: string;
}

export interface ActionDiagnostic {
  id: string;
  type?: string;
  responseCode?: string | number;
}

export interface Evidence {
  diagnostics?: ActionDiagnostic[];
}

export interface CaseEvaluationResult {
  namespacedCaseId: string;
  packId: string;
  caseId: string;
  status: 'pass' | 'fail' | 'pending';
  reason: string;
  latestMatch?: TransactionRecord;
  matchedCount: number;
  evidence?: Evidence;
}

export interface RunResult {
  timestamp: string;
  profile?: string;
  activePacks: string[];
  summary: {
    pass: number;
    fail: number;
    pending: number;
    total: number;
  };
  cases: CaseEvaluationResult[];
  redactedConfig: Record<string, unknown>;
}

export type EvaluatorModule = (
  latestMatch: TransactionRecord | undefined,
  caze: CertificationCase
) => Omit<CaseEvaluationResult, 'namespacedCaseId' | 'packId' | 'caseId'>;
