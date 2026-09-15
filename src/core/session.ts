import { loadObserverConfig } from '../config/load.js';
import { loadEnvFile } from '../config/env.js';
import { loadPackGraph } from './pack-loader.js';
import { resolveActivePacks, resolveInheritedPack } from './pack-resolver.js';
import { GpApiAuthProvider, environmentBaseUrl, type AuthInput } from '../gpapi/auth.js';
import { HttpGpApiClient } from '../gpapi/client.js';
import { CertificationEngine } from './engine.js';
import { loadEvaluators, loadPackEvaluators } from './evaluator.js';
import { enrichCasesWithDiagnostics } from './diagnostics.js';
import { redactObject } from './redaction.js';
import { caseAddress } from './ids.js';
import { GlobalPaymentsError, ERROR_CODES } from '../contract/errors.js';
import { RESULT_SCHEMA_VERSION } from '../contract/version.js';
import type { CaseRunState } from './engine.js';
import type {
  CaseEvaluationResult,
  CertificationCase,
  CertificationPack,
  ResolvedObserverConfig,
  RunResult
} from '../types/domain.js';

export interface SessionOptions {
  configPath?: string;
  envFile?: string;
  packs?: string[];
  profile?: string;
  /** `--cert` is sugar for a single `--pack`; merged here so callers stay uniform. */
  cert?: string;
}

/**
 * A fully bootstrapped certification session.
 *
 * Everything a command needs to observe and evaluate, assembled once. `run` and
 * `watch` previously each rebuilt this by hand — ~110 identical lines that drifted
 * independently. There is now one construction path, so the two commands cannot
 * disagree about how a run is set up.
 */
export interface CertificationSession {
  config: ResolvedObserverConfig;
  activePacks: string[];
  packs: CertificationPack[];
  /** Case definitions keyed by their canonical `<packId>:<caseId>` address. */
  caseIndex: Map<string, CertificationCase>;
  engine: CertificationEngine;
  authInput: AuthInput;
  authProvider: GpApiAuthProvider;
}

/**
 * Resolve configuration and pack selection without touching the network.
 *
 * Split out from {@link createSession} so read-only commands (`cases list`,
 * `packs list`) get pack resolution without paying for authentication.
 */
export async function resolveSelection(options: SessionOptions): Promise<{
  config: ResolvedObserverConfig;
  activePacks: string[];
  packs: CertificationPack[];
  caseIndex: Map<string, CertificationCase>;
}> {
  loadEnvFile(options.envFile);

  const config = await loadObserverConfig(options.configPath);

  const requested = [...(options.packs ?? []), ...(options.cert ? [options.cert] : [])];
  const activePacks = resolveActivePacks(config, requested, options.profile);

  if (activePacks.length === 0) {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_NO_PACKS_SELECTED,
      'No certification packs are active for this invocation.',
      { details: { hint: 'Pass --cert <packId>, --pack <packId>, or --profile <name>.' } }
    );
  }

  const graph = await loadPackGraph(config.packs?.directory, activePacks);
  const packs = activePacks.map((packId) => resolveInheritedPack(packId, graph));

  const caseIndex = new Map<string, CertificationCase>();
  for (const pack of packs) {
    for (const caze of pack.cases) {
      caseIndex.set(caseAddress(pack.id, caze.id), caze);
    }
  }

  return { config, activePacks, packs, caseIndex };
}

/** Build the full session, including the authenticated API client and engine. */
export async function createSession(options: SessionOptions): Promise<CertificationSession> {
  const { config, activePacks, packs, caseIndex } = await resolveSelection(options);

  if (!config.auth.appId || !config.auth.appKey) {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_AUTH_MISSING_CREDENTIALS,
      'GP API credentials are not configured (auth.appId / auth.appKey are empty).'
    );
  }

  const authInput: AuthInput = {
    appId: config.auth.appId,
    appKey: config.auth.appKey,
    environment: config.environment,
    apiVersion: config.auth.apiVersion
  };

  const authProvider = new GpApiAuthProvider();
  const client = new HttpGpApiClient({
    authProvider,
    authInput,
    accountName: config.account?.accountName
  });

  const evaluators = await loadEvaluators(config);
  const packEvaluators = await loadPackEvaluators(config, activePacks);
  const engine = new CertificationEngine(config, packs, client, evaluators, packEvaluators);

  return { config, activePacks, packs, caseIndex, engine, authInput, authProvider };
}

/** Is this case required for certification to pass? */
export function isRequiredCase(session: CertificationSession, address: string): boolean {
  return session.caseIndex.get(address)?.required === true;
}

export interface CollectResultOptions {
  profile?: string;
  /** Skip the Actions API round-trip. Used by tests and offline callers. */
  skipDiagnostics?: boolean;
}

/**
 * Turn engine state into the persisted, machine-readable run result.
 *
 * Owns diagnostics enrichment and the required/optional breakdown so `run` and
 * `watch` report identical numbers from identical logic.
 */
export async function collectRunResult(
  session: CertificationSession,
  options: CollectResultOptions = {}
): Promise<RunResult> {
  const states: CaseRunState[] = session.engine.getCaseStates();

  let cases: CaseEvaluationResult[] = states.map((state) => ({
    namespacedCaseId: state.namespacedId,
    packId: state.packId,
    caseId: state.caseId,
    status: state.status,
    reason: state.reason,
    latestMatch: state.latestMatch,
    matchedCount: state.matchedCount,
    ...(state.diagnosis ? { diagnosis: state.diagnosis } : {})
  }));

  if (!options.skipDiagnostics) {
    // Best effort: diagnostics are supplementary evidence, never a reason to fail a run.
    try {
      cases = await enrichCasesWithDiagnostics(cases, {
        authProvider: session.authProvider,
        authInput: session.authInput,
        baseUrl: environmentBaseUrl(session.config.environment),
        apiVersion: session.config.auth.apiVersion,
        fetchImpl: undefined
      });
    } catch {
      /* keep unenriched results */
    }
  }

  const summary = {
    pass: cases.filter((c) => c.status === 'pass').length,
    fail: cases.filter((c) => c.status === 'fail').length,
    pending: cases.filter((c) => c.status === 'pending').length,
    total: cases.length
  };

  const required = cases.filter((c) => isRequiredCase(session, c.namespacedCaseId));
  const requiredPassing = required.filter((c) => c.status === 'pass').length;

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    profile: options.profile,
    environment: session.config.environment,
    activePacks: session.activePacks,
    verdict: requiredPassing === required.length ? 'passed' : 'failed',
    summary,
    required: {
      total: required.length,
      passing: requiredPassing,
      failing: required.length - requiredPassing
    },
    cases,
    redactedConfig: redactObject(session.config as unknown as Record<string, unknown>)
  };
}

/**
 * Translate a run result into a certification failure, or undefined when it passed.
 * Keeps the pass/fail exit-code decision in one place for every command.
 */
export function certificationError(result: RunResult): GlobalPaymentsError | undefined {
  if (result.verdict === 'passed') {
    return undefined;
  }

  const failing = result.cases
    .filter((c) => c.status !== 'pass')
    .map((c) => c.namespacedCaseId);

  return new GlobalPaymentsError(
    ERROR_CODES.E_CERT_REQUIRED_CASES_FAILING,
    `${result.required.failing} of ${result.required.total} required case(s) are not passing.`,
    { details: { notPassing: failing.slice(0, 25), notPassingTotal: failing.length } }
  );
}
