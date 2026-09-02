import { Command } from 'commander';
import pc from 'picocolors';
import { runCommand } from '../../contract/emit.js';
import { GpCliError, ERROR_CODES } from '../../contract/errors.js';
import { resolveSelection } from '../../core/session.js';
import { caseAddress, parseCaseAddress } from '../../core/ids.js';
import type { CertificationCase } from '../../types/domain.js';

export interface CaseSummary {
  address: string;
  packId: string;
  caseId: string;
  name: string;
  required: boolean;
  mode: string;
  observability: string;
  tags: string[];
  scenario?: string;
  formQuestion?: number;
}

export interface CasesListData {
  activePacks: string[];
  totals: { cases: number; required: number; optional: number };
  packs: Array<{
    packId: string;
    name: string;
    version: string;
    caseCount: number;
    requiredCount: number;
  }>;
  cases: CaseSummary[];
}

export interface CaseDetail extends CaseSummary {
  matcher: CertificationCase['matcher'];
  expect: CertificationCase['expect'];
  evaluator?: CertificationCase['evaluator'];
}

function summarize(packId: string, caze: CertificationCase): CaseSummary {
  return {
    address: caseAddress(packId, caze.id),
    packId,
    caseId: caze.id,
    name: caze.name,
    required: caze.required,
    mode: caze.mode ?? 'latest',
    observability: caze.observability ?? 'polling',
    tags: caze.tags ?? [],
    ...(caze.scenario ? { scenario: caze.scenario } : {}),
    ...(caze.formQuestion !== undefined ? { formQuestion: caze.formQuestion } : {})
  };
}

function renderList(data: CasesListData): void {
  for (const pack of data.packs) {
    console.log();
    console.log(pc.bold(pc.blue(pack.name)), pc.gray(`(${pack.packId} v${pack.version})`));
    console.log(pc.gray(`  ${pack.caseCount} case(s), ${pack.requiredCount} required`));
    console.log();
    for (const caze of data.cases.filter((c) => c.packId === pack.packId)) {
      const flag = caze.required ? pc.yellow('REQUIRED') : pc.gray('optional');
      const tags = caze.tags.length > 0 ? ' ' + caze.tags.map((t) => pc.gray(`[${t}]`)).join(' ') : '';
      console.log(`  ${pc.cyan(caze.address)} — ${caze.name} (${flag})${tags}`);
    }
  }
  console.log();
  console.log(
    pc.gray(
      `Total: ${data.totals.cases} case(s) across ${data.packs.length} pack(s); ${data.totals.required} required.`
    )
  );
}

function renderDetail(data: CaseDetail): void {
  console.log(pc.bold('Address:'), pc.cyan(data.address));
  console.log(pc.bold('Name:'), data.name);
  console.log(pc.bold('Required:'), data.required ? pc.yellow('yes') : 'no');
  console.log(pc.bold('Mode:'), data.mode);
  console.log(pc.bold('Observability:'), data.observability);
  if (data.tags.length > 0) console.log(pc.bold('Tags:'), data.tags.join(', '));
  if (data.scenario) console.log(pc.bold('Scenario:'), data.scenario);
  console.log();
  console.log(pc.bold('Matcher'), pc.gray('(selects which transactions this case judges)'));
  for (const [key, value] of Object.entries(data.matcher)) {
    console.log(`  ${key}: ${JSON.stringify(value)}`);
  }
  console.log();
  console.log(pc.bold('Expect'), pc.gray('(what the matched transaction must satisfy)'));
  console.log(`  ${JSON.stringify(data.expect, null, 2).split('\n').join('\n  ')}`);
  if (data.evaluator) {
    console.log();
    console.log(pc.bold('Evaluator:'), JSON.stringify(data.evaluator));
  }
}

export function registerCasesCommands(program: Command): void {
  const cases = program.command('cases').description('Inspect the certification case catalog');

  cases
    .command('list')
    .description('List every resolved case with its canonical address')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--pack <packId...>', 'Activate one or more packs by id')
    .option('--profile <name>', 'Activate the packs defined by a config profile')
    .option('--cert <name>', 'Shorthand for --pack with a single bundled suite id')
    .option('--required-only', 'Restrict output to required cases')
    .option('--tag <tag...>', 'Restrict output to cases carrying all of these tags')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: {
      config?: string;
      envFile: string;
      pack?: string[];
      profile?: string;
      cert?: string;
      requiredOnly?: boolean;
      tag?: string[];
      json?: boolean;
    }) => {
      await runCommand<CasesListData>('cases.list', { json: options.json }, async () => {
        const selection = await resolveSelection({
          configPath: options.config,
          envFile: options.envFile,
          packs: options.pack,
          profile: options.profile,
          cert: options.cert
        });

        let all = selection.packs.flatMap((pack) => pack.cases.map((caze) => summarize(pack.id, caze)));

        if (options.requiredOnly) {
          all = all.filter((c) => c.required);
        }
        if (options.tag && options.tag.length > 0) {
          all = all.filter((c) => options.tag!.every((tag) => c.tags.includes(tag)));
        }

        const data: CasesListData = {
          activePacks: selection.activePacks,
          totals: {
            cases: all.length,
            required: all.filter((c) => c.required).length,
            optional: all.filter((c) => !c.required).length
          },
          packs: selection.packs.map((pack) => ({
            packId: pack.id,
            name: pack.name,
            version: pack.version,
            caseCount: all.filter((c) => c.packId === pack.id).length,
            requiredCount: all.filter((c) => c.packId === pack.id && c.required).length
          })),
          cases: all
        };

        return {
          data,
          render: renderList,
          nextActions: [
            {
              reason: 'Read the matcher and expectation behind a specific case.',
              command: `gpcli cases show ${all[0]?.address ?? '<packId>:<caseId>'} --json`
            },
            {
              reason: 'Evaluate these cases against observed transactions.',
              command: `gpcli run --cert ${selection.activePacks[0]} --json`
            }
          ]
        };
      });
    });

  cases
    .command('show')
    .argument('<caseAddress>', 'Canonical case address, formatted <packId>:<caseId>')
    .description('Show one fully resolved case definition')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (address: string, options: { config?: string; envFile: string; json?: boolean }) => {
      await runCommand<CaseDetail>('cases.show', { json: options.json }, async () => {
        const parsed = parseCaseAddress(address);
        if (!parsed) {
          throw new GpCliError(
            ERROR_CODES.E_USAGE,
            `"${address}" is not a case address. Expected the form <packId>:<caseId>.`,
            {
              remediation: 'Run `gpcli cases list --json` and copy an `address` value verbatim.',
              details: { received: address }
            }
          );
        }

        const selection = await resolveSelection({
          configPath: options.config,
          envFile: options.envFile,
          packs: [parsed.packId]
        });

        const caze = selection.caseIndex.get(parsed.address);
        if (!caze) {
          throw new GpCliError(ERROR_CODES.E_CASE_NOT_FOUND, `No case "${parsed.address}" in pack "${parsed.packId}".`, {
            details: {
              packId: parsed.packId,
              available: [...selection.caseIndex.keys()].slice(0, 50)
            }
          });
        }

        const data: CaseDetail = {
          ...summarize(parsed.packId, caze),
          matcher: caze.matcher,
          expect: caze.expect,
          ...(caze.evaluator ? { evaluator: caze.evaluator } : {})
        };

        return {
          data,
          render: renderDetail,
          nextActions: [
            {
              reason: 'Evaluate this pack against observed transactions.',
              command: `gpcli run --cert ${parsed.packId} --json`
            }
          ]
        };
      });
    });
}
