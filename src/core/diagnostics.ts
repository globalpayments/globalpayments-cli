import type { CaseEvaluationResult, TransactionRecord } from '../types/domain.js';
import type { ActionRecord } from '../gpapi/actions.js';
import { fetchActionsPage } from '../gpapi/actions.js';
import type { ActionsApiDeps, ActionsQuery } from '../gpapi/actions.js';

/**
 * Enriches failed cases with diagnostics from the Actions API.
 * This is a best-effort operation: if fetching actions fails, the case
 * result is returned unchanged.
 */
export async function enrichCaseWithDiagnostics(
  caseResult: CaseEvaluationResult,
  deps: ActionsApiDeps
): Promise<CaseEvaluationResult> {
  // Only enrich failed cases
  if (caseResult.status !== 'fail' || !caseResult.latestMatch) {
    return caseResult;
  }

  try {
    // Fetch actions for the matched transaction
    const query: ActionsQuery = {
      page_size: 10,
      order: 'desc',
      order_by: 'time_created',
      resource: 'TRANSACTIONS',
      resource_id: caseResult.latestMatch.id
    };

    const actions = await fetchActionsPage(deps, query);

    if (actions.length === 0) {
      return caseResult;
    }

    // Attach diagnostics to the case result
    const diagnostics = actions.map((action) => ({
      id: action.id,
      ...(action.type && { type: action.type }),
      ...(action.responseCode !== undefined && { responseCode: action.responseCode })
    }));

    return {
      ...caseResult,
      evidence: {
        ...caseResult.evidence,
        diagnostics
      }
    };
  } catch {
    // Graceful degradation: if enrichment fails, return the case result unchanged
    return caseResult;
  }
}

/**
 * Batch enrich multiple case results with diagnostics from the Actions API.
 * Fetches actions concurrently for all failed cases.
 */
export async function enrichCasesWithDiagnostics(
  cases: CaseEvaluationResult[],
  deps: ActionsApiDeps
): Promise<CaseEvaluationResult[]> {
  const failedCases = cases.filter((c) => c.status === 'fail' && c.latestMatch);

  if (failedCases.length === 0) {
    return cases;
  }

  try {
    // Fetch diagnostics for all failed cases concurrently
    const enrichedMap = await Promise.all(
      failedCases.map((caseResult) => enrichCaseWithDiagnostics(caseResult, deps))
    );

    // Rebuild the results, replacing failed cases with enriched versions
    const enrichedByNamespacedId = new Map(enrichedMap.map((c) => [c.namespacedCaseId, c]));

    return cases.map((c) => enrichedByNamespacedId.get(c.namespacedCaseId) ?? c);
  } catch {
    // If batch enrichment fails, return original results
    return cases;
  }
}
