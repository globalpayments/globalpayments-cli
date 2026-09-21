import { Command } from 'commander';
import pc from 'picocolors';
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
  console.log(pc.bold('Global Payments certification report'));
  console.log();
  console.log('  Source:      ', pc.cyan(data.sourcePath));
  console.log('  Timestamp:   ', pc.cyan(data.timestamp));
  console.log('  Environment: ', pc.blue(data.environment));
  console.log('  Packs:       ', pc.cyan(data.activePacks.join(', ')));
  console.log(
    '  Verdict:     ',
    data.verdict === 'passed' ? pc.green('PASSED') : pc.red('FAILED'),
    pc.gray(`(${data.required.passing}/${data.required.total} required passing)`)
  );
  console.log(
    '  Cases:       ',
    `${pc.green(`${data.summary.pass} pass`)}, ${pc.red(`${data.summary.fail} fail`)}, ${pc.gray(`${data.summary.pending} pending`)} of ${data.summary.total}`
  );

  const byPack = new Map<string, ReportData['cases']>();
  for (const caze of data.cases) {
    const bucket = byPack.get(caze.packId) ?? [];
    bucket.push(caze);
    byPack.set(caze.packId, bucket);
  }

  for (const [packId, cases] of byPack) {
    console.log();
    console.log(pc.blue(`${packId}:`));
    for (const caze of cases) {
      const icon = caze.status === 'pass' ? pc.green('✓') : caze.status === 'fail' ? pc.red('✗') : pc.gray('○');
      console.log(`  ${icon} ${pc.cyan(caze.namespacedCaseId)} — ${caze.reason}`);
      if (caze.latestMatch) {
        console.log(pc.gray(`      matched ${caze.latestMatch.reference ?? caze.latestMatch.id}`));
      }
      const topFix = caze.diagnosis?.fixes[0];
      if (topFix) {
        console.log(`      ${pc.yellow('fix:')} ${topFix.instruction}`);
      }
    }
  }

  if (data.cases.some((caze) => caze.diagnosis !== undefined)) {
    console.log();
    console.log(pc.gray('Field-level causes and the full fix plan: ') + pc.yellow('globalpayments diagnose'));
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
