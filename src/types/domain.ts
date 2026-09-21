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

/**
 * Why a case is not passing, and what to change in the request to make it pass.
 *
 * `reason` answers "what happened". A diagnosis answers the two questions that
 * actually unblock a caller: *which field* caused the miss, and *what should the
 * next request look like*. Because globalpayments is an observer, the remedy is always a
 * change to the transaction you send — never a change to this tool — so every fix
 * is phrased as an instruction about the request.
 *
 * Computed by `src/core/diagnosis.ts`, which is the only place these are built.
 */
export type DiagnosisCode =
  /** Nothing at all was in the polling window. */
  | 'NO_TRANSACTIONS_OBSERVED'
  /** Transactions were observed, but none shares a single matcher field with this case. */
  | 'NO_NEAR_MATCH'
  /** A transaction came close; specific matcher fields differ. */
  | 'MATCHER_MISMATCH'
  /** A transaction matched, but its outcome violated `expect`. */
  | 'EXPECTATION_VIOLATED'
  /** Two or more equally recent transactions matched, so "latest wins" is undecidable. */
  | 'AMBIGUOUS_MATCH'
  /**
   * The poll itself failed, so the window could not be read. Nothing is known about
   * this case. Distinct from NO_TRANSACTIONS_OBSERVED, where the window was read
   * successfully and was genuinely empty.
   */
  | 'OBSERVATION_FAILED';

export type DeltaKind = 'matcher' | 'expectation';

export type DeltaComparison = 'equals' | 'startsWith' | 'oneOf';

/** One field-level expected-vs-actual comparison. */
export interface FieldDelta {
  /** Transaction field the constraint reads, e.g. `amount`. */
  field: string;
  /** Where the constraint is declared in the case YAML, e.g. `matcher.amount`. */
  path: string;
  kind: DeltaKind;
  comparison: DeltaComparison;
  expected: unknown;
  actual: unknown;
  satisfied: boolean;
}

/** An observed transaction that partially satisfied the case matcher. */
export interface NearMiss {
  transactionId: string;
  reference?: string;
  timeCreated: string;
  status?: string;
  /** Fraction of *blocking* matcher constraints satisfied, 0–1, rounded to 2dp. */
  score: number;
  fieldsCompared: number;
  fieldsMatched: number;
  matchedFields: string[];
  /** Blocking constraints that differed. These are the reason the matcher rejected it. */
  mismatchedFields: FieldDelta[];
  /**
   * Reference constraints that differed.
   *
   * The matcher's strategy ladder ends in `composite`, which ignores `reference`
   * entirely — so a reference mismatch never prevents a match. Reported separately
   * so it is not mistaken for the cause of a miss.
   */
  advisoryFields: FieldDelta[];
}

export type FixActionKind =
  | 'send-transaction'
  | 'change-request-field'
  | 'change-transaction-outcome'
  | 'widen-window'
  | 'disambiguate'
  | 'repair-connection';

/**
 * A single corrective step. `instruction` is written for a human; `field`,
 * `currentValue`, and `requiredValue` are there so an agent can apply the change
 * without parsing prose.
 */
export interface Fix {
  action: FixActionKind;
  field?: string;
  currentValue?: unknown;
  requiredValue?: unknown;
  instruction: string;
  confidence: 'high' | 'medium' | 'low';
}

/** The canonical request that satisfies a case. */
export interface RequiredRequest {
  /** Fields the request must carry for the matcher to select it. */
  send: Record<string, unknown>;
  /** What the resulting transaction must end up as for the case to pass. */
  mustResultIn: Record<string, unknown>;
  notes: string[];
}

export interface CaseDiagnosis {
  code: DiagnosisCode;
  /** One sentence stating the cause. Human prose — branch on `code`, not on this. */
  summary: string;
  observed: {
    transactionsInWindow: number;
    candidatesMatched: number;
  };
  /** Ordered most-likely-first. `fixes[0]` is the single next thing to do. */
  fixes: Fix[];
  /** Closest observed transactions, best first. Empty when nothing was observed. */
  nearMisses: NearMiss[];
  /** Per-field expectation results for the matched transaction. Empty unless matched. */
  expectationDeltas: FieldDelta[];
  requiredRequest: RequiredRequest;
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
  /**
   * Why this case is not passing and what to change in the request to fix it.
   * Present only on non-passing cases — a green case has nothing to remediate.
   */
  diagnosis?: CaseDiagnosis;
}

export interface RunResultSummary {
  pass: number;
  fail: number;
  pending: number;
  total: number;
}

export interface RunResultRequired {
  total: number;
  passing: number;
  failing: number;
}

/**
 * The persisted, machine-readable outcome of a certification run.
 *
 * `verdict` is the single field a caller should branch on: it already encodes the
 * required-case rule, so consumers never reimplement it. `schemaVersion` is checked
 * by `globalpayments report` before the artifact is trusted.
 */
export interface RunResult {
  schemaVersion: number;
  timestamp: string;
  profile?: string;
  environment: Environment;
  activePacks: string[];
  verdict: 'passed' | 'failed';
  summary: RunResultSummary;
  required: RunResultRequired;
  cases: CaseEvaluationResult[];
  redactedConfig: Record<string, unknown>;
}

export type EvaluatorModule = (
  latestMatch: TransactionRecord | undefined,
  caze: CertificationCase
) => Omit<CaseEvaluationResult, 'namespacedCaseId' | 'packId' | 'caseId'>;
