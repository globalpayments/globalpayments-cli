import { Command } from 'commander';
import pc from 'picocolors';
import { runCommand } from '../contract/emit.js';
import { GlobalPaymentsError, ERROR_CODES } from '../contract/errors.js';
import { listBuiltinPackIds, resolveBuiltinPacksDir } from '../core/builtin-packs.js';
import { loadPackGraph } from '../core/pack-loader.js';
import { resolveInheritedPack } from '../core/pack-resolver.js';
import { loadObserverConfig } from '../config/load.js';
import { loadEnvFile } from '../config/env.js';
import { caseAddress } from '../core/ids.js';

export interface PackSummary {
  packId: string;
  name: string;
  version: string;
  source: 'bundled' | 'local';
  extends: string[];
  tags: string[];
  region?: string;
  industry?: string;
  channel?: string;
  caseCount: number;
  requiredCount: number;
}

export interface PacksListData {
  bundledPacksDirectory: string;
  localPacksDirectory?: string;
  packs: PackSummary[];
}

export interface PackDetailData extends PackSummary {
  cases: Array<{ address: string; name: string; required: boolean; tags: string[] }>;
}

function renderList(data: PacksListData): void {
  console.log(pc.bold('Available certification packs'));
  console.log();
  for (const pack of data.packs) {
    console.log(`  ${pc.cyan(pack.packId)} ${pc.gray(`v${pack.version}`)} — ${pack.name}`);
    console.log(
      pc.gray(
        `      ${pack.caseCount} case(s), ${pack.requiredCount} required` +
          `${pack.region ? ` · region=${pack.region}` : ''}` +
          `${pack.channel ? ` · channel=${pack.channel}` : ''}` +
          `${pack.extends.length > 0 ? ` · extends ${pack.extends.join(', ')}` : ''}`
      )
    );
  }
  console.log();
  console.log(pc.gray(`Bundled from ${data.bundledPacksDirectory}`));
}

function renderDetail(data: PackDetailData): void {
  console.log(pc.bold(data.name), pc.gray(`(${data.packId} v${data.version})`));
  console.log(pc.gray(`  ${data.caseCount} case(s), ${data.requiredCount} required`));
  console.log();
  for (const caze of data.cases) {
    const flag = caze.required ? pc.yellow('REQUIRED') : pc.gray('optional');
    console.log(`  ${pc.cyan(caze.address)} — ${caze.name} (${flag})`);
  }
}

async function summarizePack(
  packId: string,
  packsDir: string | undefined,
  bundled: Set<string>
): Promise<{ summary: PackSummary; cases: PackDetailData['cases'] }> {
  const graph = await loadPackGraph(packsDir, [packId]);
  const resolved = resolveInheritedPack(packId, graph);
  const cases = resolved.cases.map((caze) => ({
    address: caseAddress(resolved.id, caze.id),
    name: caze.name,
    required: caze.required,
    tags: caze.tags ?? []
  }));

  return {
    summary: {
      packId: resolved.id,
      name: resolved.name,
      version: resolved.version,
      source: bundled.has(packId) ? 'bundled' : 'local',
      extends: resolved.extends ?? [],
      tags: resolved.tags ?? [],
      ...(resolved.metadata?.region ? { region: resolved.metadata.region } : {}),
      ...(resolved.metadata?.industry ? { industry: resolved.metadata.industry } : {}),
      ...(resolved.metadata?.channel ? { channel: resolved.metadata.channel } : {}),
      caseCount: cases.length,
      requiredCount: cases.filter((c) => c.required).length
    },
    cases
  };
}

/**
 * Pack discovery.
 *
 * Previously the only way to learn which packs existed was a footnote printed by
 * `doctor` and `init`. Discovery is a first-class need — it is the precondition for
 * every other command — so it gets a first-class command.
 */
export function registerPacksCommands(program: Command): void {
  const packs = program.command('packs').description('Discover available certification packs');

  packs
    .command('list')
    .description('List every pack this build can run, bundled and local')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { config?: string; envFile: string; json?: boolean }) => {
      await runCommand<PacksListData>('packs.list', { json: options.json }, async () => {
        loadEnvFile(options.envFile);
        const config = await loadObserverConfig(options.config);
        const localDir = config.packs?.directory;

        const bundledIds = await listBuiltinPackIds();
        const bundled = new Set(bundledIds);

        const summaries: PackSummary[] = [];
        for (const packId of bundledIds) {
          const { summary } = await summarizePack(packId, localDir, bundled);
          summaries.push(summary);
        }

        const data: PacksListData = {
          bundledPacksDirectory: resolveBuiltinPacksDir(),
          ...(localDir ? { localPacksDirectory: localDir } : {}),
          packs: summaries.sort((a, b) => a.packId.localeCompare(b.packId))
        };

        return {
          data,
          render: renderList,
          nextActions: [
            {
              reason: 'Inspect what a suite asserts before running it.',
              command: `globalpayments cases list --cert ${summaries[0]?.packId ?? '<packId>'} --json`
            },
            {
              reason: 'Evaluate a suite against observed transactions.',
              command: `globalpayments run --cert ${summaries[0]?.packId ?? '<packId>'} --json`
            }
          ]
        };
      });
    });

  packs
    .command('show')
    .argument('<packId>', 'Pack id, as listed by `globalpayments packs list`')
    .description('Show one pack with its fully resolved case list')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (packId: string, options: { config?: string; envFile: string; json?: boolean }) => {
      await runCommand<PackDetailData>('packs.show', { json: options.json }, async () => {
        loadEnvFile(options.envFile);
        const config = await loadObserverConfig(options.config);
        const bundled = new Set(await listBuiltinPackIds());

        if (!bundled.has(packId) && !config.packs?.directory) {
          throw new GlobalPaymentsError(ERROR_CODES.E_PACK_NOT_FOUND, `Pack "${packId}" not found.`, {
            details: { available: [...bundled] }
          });
        }

        const { summary, cases } = await summarizePack(packId, config.packs?.directory, bundled);

        return {
          data: { ...summary, cases } satisfies PackDetailData,
          render: renderDetail,
          nextActions: [
            { reason: 'Evaluate this pack against observed transactions.', command: `globalpayments run --cert ${packId} --json` }
          ]
        };
      });
    });
}
