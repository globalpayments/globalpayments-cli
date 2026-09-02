import { latestMatch } from './matching.js';
import { caseAddress } from './ids.js';
import type {
  CaseEvaluationResult,
  CertificationCase,
  CertificationPack,
  EvaluatorModule,
  TransactionRecord,
  ObserverConfig
} from '../types/domain.js';

function defaultEvaluate(latest: TransactionRecord | undefined, caze: CertificationCase): Omit<CaseEvaluationResult, 'namespacedCaseId' | 'packId' | 'caseId'> {
  if (!latest) {
    return {
      status: 'pending',
      reason: 'No matching transactions found in current window',
      latestMatch: undefined,
      matchedCount: 0
    };
  }

  const latestExpect = caze.expect.latest;

  const statusOk = latestExpect?.statusIn ? latestExpect.statusIn.includes(latest.status ?? '') : true;

  // responseCode is not included in the /transactions list endpoint — only in the
  // original transaction CREATE response and the Actions API. Skip this check when
  // the field is absent rather than failing; status is the primary pass signal.
  const responseOk = latestExpect?.responseCodeIn && latest.responseCode !== undefined
    ? latestExpect.responseCodeIn.includes(latest.responseCode)
    : true;

  if (statusOk && responseOk) {
    return {
      status: 'pass',
      reason: 'Latest matching transaction satisfies expectation',
      latestMatch: latest,
      matchedCount: 1
    };
  }

  const reasons: string[] = [];
  if (!statusOk) {
    reasons.push(`status ${latest.status ?? '(none)'} not in [${latestExpect?.statusIn?.join(', ')}]`);
  }
  if (!responseOk) {
    reasons.push(`responseCode ${latest.responseCode} not in [${latestExpect?.responseCodeIn?.join(', ')}]`);
  }

  return {
    status: 'fail',
    reason: `Latest match failed: ${reasons.join('; ')}`,
    latestMatch: latest,
    matchedCount: 1
  };
}

function resolveEvaluatorName(pack: CertificationPack, caze: CertificationCase): string | undefined {
  if (caze.evaluator?.type === 'script') {
    return caze.evaluator.script;
  }

  const override = pack.evaluators?.overrides?.[caze.id];
  if (override) {
    return override;
  }

  return pack.evaluators?.default;
}

export function evaluateCase(
  pack: CertificationPack,
  caze: CertificationCase,
  matches: TransactionRecord[],
  evaluators: Record<string, EvaluatorModule>
): CaseEvaluationResult {
  const namespacedCaseId = caseAddress(pack.id, caze.id);
  const latest = latestMatch(matches);

  const evaluatorName = resolveEvaluatorName(pack, caze);
  const result = evaluatorName && evaluators[evaluatorName]
    ? evaluators[evaluatorName](latest, caze)
    : defaultEvaluate(latest, caze);

  return {
    namespacedCaseId,
    packId: pack.id,
    caseId: caze.id,
    status: result.status,
    reason: result.reason,
    latestMatch: result.latestMatch,
    matchedCount: matches.length
  };
}

export function summarizeCases(cases: CaseEvaluationResult[]): {
  pass: number;
  fail: number;
  pending: number;
  total: number;
} {
  const summary = {
    pass: 0,
    fail: 0,
    pending: 0,
    total: cases.length
  };

  for (const caze of cases) {
    summary[caze.status] += 1;
  }

  return summary;
}

/**
 * Load evaluators from the config's default evaluators location.
 * Returns a map of evaluator name -> evaluator function.
 */
export async function loadEvaluators(config: ObserverConfig): Promise<Record<string, EvaluatorModule>> {
  // In MVP, return empty map (no custom evaluators)
  // Will be extended to load from config.packs.directory/evaluators/
  return {};
}

/**
 * Load pack-specific evaluators.
 * Returns a map of packId -> (evaluatorName -> evaluatorFunction)
 */
export async function loadPackEvaluators(
  config: ObserverConfig,
  activePacks: string[]
): Promise<Record<string, Record<string, EvaluatorModule>>> {
  // In MVP, return empty map (no pack-specific evaluators)
  // Will be extended to load from each pack's evaluators/
  return {};
}
