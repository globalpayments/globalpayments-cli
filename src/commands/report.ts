import { Command } from 'commander';
import { statusMark, t } from '../ui/index.js';
import { hang, humanCommand, inlineCode } from '../ui/text.js';
import { readFile } from 'node:fs/promises';
import { runCommand } from '../contract/emit.js';
import { GlobalPaymentsError, ERROR_CODES } from '../contract/errors.js';
import { RESULT_SCHEMA_VERSION } from '../contract/version.js';
import type { RunResult } from '../types/domain.js';

const DEFAULT_RESULT_PATH = '.globalpayments/results/latest.json';

export interface ReportData extends RunResult {
  sourcePath: string;
}

function renderReport(data: ReportData): void {
  console.log(t.strong('Global Payments certification report'));
  console.log();
  console.log('  Source:      ', t.accent(data.sourcePath));
  console.log('  Timestamp:   ', t.accent(data.timestamp));
  console.log('  Environment: ', t.accent(data.environment));
  console.log('  Packs:       ', t.accent(data.activePacks.join(', ')));
  console.log(
    '  Verdict:     ',
    data.verdict === 'passed' ? t.success('PASSED') : t.danger('FAILED'),
    t.muted(`(${data.required.passing}/${data.required.total} required passing)`)
  );
  console.log(
    '  Cases:       ',
    `${t.success(`${data.summary.pass} pass`)}, ${t.danger(`${data.summary.fail} fail`)}, ${t.muted(`${data.summary.pending} pending`)} of ${data.summary.total}`
  );

  const byPack = new Map<string, ReportData['cases']>();
  for (const caze of data.cases) {
    const bucket = byPack.get(caze.packId) ?? [];
    bucket.push(caze);
    byPack.set(caze.packId, bucket);
  }

  for (const [packId, cases] of byPack) {
    console.log();
    console.log(t.accent(`${packId}:`));
    for (const caze of cases) {
      const icon = caze.status === 'pass' ? statusMark('pass') : caze.status === 'fail' ? statusMark('fail') : statusMark('pending');
      console.log(`  ${icon} ${t.accent(caze.namespacedCaseId)} — ${caze.reason}`);
      if (caze.latestMatch) {
        console.log(t.muted(`      matched ${caze.latestMatch.reference ?? caze.latestMatch.id}`));
      }
      const topFix = caze.diagnosis?.fixes[0];
      if (topFix) {
        console.log(`      ${t.warning('fix:')} ${hang(inlineCode(topFix.instruction), 11)}`);
      }
    }
  }

  if (data.cases.some((caze) => caze.diagnosis !== undefined)) {
    console.log();
    console.log(t.muted('Field-level causes and the full fix plan: ') + t.command(humanCommand('globalpayments diagnose')));
  }
  console.log();
}

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description('Read a persisted run result and re-render it without re-running')
    .option('--input <path>', 'Path to a saved result artifact', DEFAULT_RESULT_PATH)
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { input: string; json?: boolean }) => {
      await runCommand<ReportData>('report', { json: options.json }, async () => {
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

        const warnings =
          parsed.schemaVersion === RESULT_SCHEMA_VERSION
            ? []
            : [
                {
                  code: 'W_RESULT_SCHEMA_MISMATCH',
                  message: `Artifact schemaVersion ${parsed.schemaVersion ?? 'missing'} does not match the expected ${RESULT_SCHEMA_VERSION}. Fields may be absent. Regenerate with \`globalpayments run\`.`
                }
              ];

        return {
          data: { ...parsed, sourcePath: options.input } satisfies ReportData,
          warnings,
          render: renderReport,
          nextActions:
            parsed.verdict === 'passed'
              ? []
              : [
                  {
                    reason: 'Get the field-level cause and an ordered fix plan for every non-passing case.',
                    command: 'globalpayments diagnose --json'
                  }
                ]
        };
      });
    });
}
