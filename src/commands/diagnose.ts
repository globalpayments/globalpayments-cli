import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { runCommand } from '../contract/emit.js';
import { GlobalPaymentsError, ERROR_CODES } from '../contract/errors.js';
import type { Warning } from '../contract/envelope.js';
import { RESULT_SCHEMA_VERSION } from '../contract/version.js';
import { parseCaseAddress } from '../core/ids.js';
import { buildFixPlan, renderDiagnose, type DiagnoseView, type DiagnosedCaseView } from '../io/diagnose-renderer.js';
import type { RunResult } from '../types/domain.js';

const DEFAULT_RESULT_PATH = '.globalpayments/results/latest.json';

/**
 * The diagnose payload.
 *
 * Identical to the view model the renderer consumes — deliberately the same type, so
 * the JSON a caller parses and the text a human reads can never describe different
 * things.
 */
export type DiagnoseData = DiagnoseView;

export function registerDiagnoseCommand(program: Command): void {
  program
    .command('diagnose')
    .argument('[caseAddress]', 'Restrict the diagnosis to one case, formatted <packId>:<caseId>')
    .description(
      'Explain why cases are not passing and what to change in the request to make them pass. Reads the last run result; performs no network calls.'
    )
    .option('--input <path>', 'Path to a saved result artifact', DEFAULT_RESULT_PATH)
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (address: string | undefined, options: { input: string; json?: boolean }) => {
      await runCommand<DiagnoseData>('diagnose', { json: options.json }, async () => {
        if (address && !parseCaseAddress(address)) {
          throw new GlobalPaymentsError(
            ERROR_CODES.E_USAGE,
            `"${address}" is not a case address. Expected the form <packId>:<caseId>.`,
            {
              remediation: 'Run `globalpayments report --json` and copy a `namespacedCaseId` value verbatim.',
              details: { received: address }
            }
          );
        }

        let raw: string;
        try {
          raw = await readFile(options.input, 'utf8');
        } catch (error) {
          throw new GlobalPaymentsError(ERROR_CODES.E_RESULT_NOT_FOUND, `No result artifact at ${options.input}.`, {
            details: { path: options.input },
            cause: error
          });
        }

        let parsed: RunResult;
        try {
          parsed = JSON.parse(raw) as RunResult;
        } catch (error) {
          throw new GlobalPaymentsError(ERROR_CODES.E_INTERNAL, `Result artifact at ${options.input} is not valid JSON.`, {
            remediation: 'Delete the corrupt artifact and produce a new one with `globalpayments run`.',
            details: { path: options.input },
            cause: error
          });
        }

        const allCases = parsed.cases ?? [];

        if (address && !allCases.some((caze) => caze.namespacedCaseId === address)) {
          throw new GlobalPaymentsError(
            ERROR_CODES.E_CASE_NOT_FOUND,
            `The result at ${options.input} contains no case "${address}".`,
            {
              remediation: 'Run `globalpayments report --json` to list the cases this result covers.',
              details: { path: options.input, available: allCases.map((c) => c.namespacedCaseId).slice(0, 50) }
            }
          );
        }

        const scoped = address ? allCases.filter((caze) => caze.namespacedCaseId === address) : allCases;

        const cases: DiagnosedCaseView[] = scoped
          .filter((caze) => caze.diagnosis !== undefined)
          .map((caze) => ({
            address: caze.namespacedCaseId,
            status: caze.status,
            reason: caze.reason,
            diagnosis: caze.diagnosis!
          }));

        const byCode: Record<string, number> = {};
        for (const view of cases) {
          byCode[view.diagnosis.code] = (byCode[view.diagnosis.code] ?? 0) + 1;
        }

        const fixPlan = buildFixPlan(cases);

        const data: DiagnoseData = {
          sourcePath: options.input,
          timestamp: parsed.timestamp,
          environment: parsed.environment,
          activePacks: parsed.activePacks ?? [],
          verdict: parsed.verdict,
          totals: {
            cases: scoped.length,
            passing: scoped.filter((caze) => caze.status === 'pass').length,
            diagnosed: cases.length
          },
          byCode,
          cases,
          fixPlan
        };

        const warnings: Warning[] = [];

        if (parsed.schemaVersion !== RESULT_SCHEMA_VERSION) {
          warnings.push({
            code: 'W_RESULT_SCHEMA_MISMATCH',
            message: `Artifact schemaVersion ${parsed.schemaVersion ?? 'missing'} does not match the expected ${RESULT_SCHEMA_VERSION}. Fields may be absent. Regenerate with \`globalpayments run\`.`
          });
        }

        // A non-passing case with no diagnosis means the artifact predates diagnosis
        // support. Say so, rather than silently reporting nothing to fix.
        const undiagnosed = scoped.filter((caze) => caze.status !== 'pass' && caze.diagnosis === undefined);
        if (undiagnosed.length > 0) {
          warnings.push({
            code: 'W_DIAGNOSIS_UNAVAILABLE',
            message: `${undiagnosed.length} non-passing case(s) carry no diagnosis; this artifact was produced before diagnosis support. Re-run to get field-level causes and fixes.`
          });
        }

        const pack = data.activePacks[0] ?? '<packId>';

        return {
          data,
          warnings,
          render: (value) => renderDiagnose(value, console.log),
          nextActions: [
            ...(cases[0]
              ? [
                  {
                    reason: 'Read the matcher and expectation behind the first diagnosed case.',
                    command: `globalpayments cases show ${cases[0].address} --json`
                  }
                ]
              : []),
            {
              reason: 'After applying the fix plan and re-sending the transactions, re-evaluate.',
              command: `globalpayments run --cert ${pack} --json`
            }
          ]
        };
      });
    });
}
