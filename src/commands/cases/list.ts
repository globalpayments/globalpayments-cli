import { Command } from 'commander';
import pc from 'picocolors';
import { loadObserverConfig } from '../../config/load.js';
import { loadEnvFile } from '../../config/env.js';
import { loadPackGraph } from '../../core/pack-loader.js';
import { resolveActivePacks, resolveInheritedPack } from '../../core/pack-resolver.js';
import type { CertificationCase } from '../../types/domain.js';
import { registerCasesShowCommand } from './show.js';

function formatTags(tags?: string[]): string {
  if (!tags || tags.length === 0) {
    return '';
  }
  return tags.map((t) => pc.gray(`[${t}]`)).join(' ');
}

function formatCase(packId: string, caze: CertificationCase): string {
  const required = caze.required ? pc.yellow('REQUIRED') : pc.gray('optional');
  const tags = formatTags(caze.tags);
  const namespacedId = `${packId}:${caze.id}`;
  return `  ${pc.cyan(namespacedId)} - ${caze.name} (${required}) ${tags}`;
}

export function registerCasesCommands(program: Command): void {
  const cases = program.command('cases').description('Certification case catalog commands');

  cases
    .command('list')
    .description('List resolved cases grouped by pack')
    .option('--config <path>', 'Config path', '.gpcli/config.yaml')
    .option('--env-file <path>', 'Env file path', '.env')
    .option('--profile <name>', 'Activate profile-defined packs')
    .option('--pack <packId...>', 'Activate additional pack(s)')
    .action(async (options: { config: string; envFile: string; profile?: string; pack?: string[] }) => {
      try {
        loadEnvFile(options.envFile);
        const config = await loadObserverConfig(options.config);

        // Resolve active packs
        const activePacks = resolveActivePacks(config, options.pack ?? [], options.profile);

        if (activePacks.length === 0) {
          console.log(pc.yellow('No packs activated. Use --pack <packId> or --profile <name>'));
          return;
        }

        // Load pack graph
        const graph = await loadPackGraph(config.packs.directory, activePacks);

        // Resolve and display each pack
        for (const packId of activePacks) {
          const resolved = resolveInheritedPack(packId, graph);
          console.log(pc.bold(pc.blue(`\n${resolved.name || packId}`)));
          console.log(
            pc.gray(
              `  Version: ${resolved.version}${resolved.metadata?.region ? ` | Region: ${resolved.metadata.region}` : ''}${resolved.metadata?.industry ? ` | Industry: ${resolved.metadata.industry}` : ''}`
            )
          );

          if (resolved.cases.length === 0) {
            console.log(pc.gray('  (no cases)'));
          } else {
            console.log();
            for (const caze of resolved.cases) {
              console.log(formatCase(resolved.id, caze));
            }
          }
        }

        console.log();
        console.log(
          pc.gray(
            `Total: ${activePacks.length} pack(s)`
          )
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(pc.red('cases list failed:'), msg);
        process.exitCode = 1;
      }
    });

  registerCasesShowCommand(cases);
}
