import { Command } from 'commander';
import pc from 'picocolors';
import { loadObserverConfig } from '../../config/load.js';
import { loadEnvFile } from '../../config/env.js';
import { loadPackGraph } from '../../core/pack-loader.js';
import { resolveInheritedPack } from '../../core/pack-resolver.js';
import type { CertificationCase } from '../../types/domain.js';

function showCaseDetails(caze: CertificationCase): void {
  console.log(pc.bold('ID:'), caze.id);
  console.log(pc.bold('Name:'), caze.name);
  console.log(pc.bold('Required:'), caze.required ? pc.yellow('yes') : 'no');

  if (caze.tags && caze.tags.length > 0) {
    console.log(pc.bold('Tags:'), caze.tags.join(', '));
  }

  if (caze.mode) {
    console.log(pc.bold('Mode:'), caze.mode);
  }

  console.log();
  console.log(pc.bold('Matcher:'));
  for (const [key, value] of Object.entries(caze.matcher)) {
    console.log(`  ${key}: ${value}`);
  }

  console.log();
  console.log(pc.bold('Expectations:'));
  if (caze.expect.latest) {
    console.log('  Latest:');
    for (const [key, value] of Object.entries(caze.expect.latest)) {
      console.log(`    ${key}: ${JSON.stringify(value)}`);
    }
  }
  if (caze.expect.sequence) {
    console.log('  Sequence:');
    for (const [key, value] of Object.entries(caze.expect.sequence)) {
      console.log(`    ${key}: ${JSON.stringify(value)}`);
    }
  }
  if (caze.expect.aggregate) {
    console.log('  Aggregate:');
    for (const [key, value] of Object.entries(caze.expect.aggregate)) {
      console.log(`    ${key}: ${JSON.stringify(value)}`);
    }
  }

  if (caze.evaluator) {
    console.log();
    console.log(pc.bold('Evaluator:'));
    console.log(`  Type: ${caze.evaluator.type}`);
    if (caze.evaluator.script) {
      console.log(`  Script: ${caze.evaluator.script}`);
    }
    if (caze.evaluator.export) {
      console.log(`  Export: ${caze.evaluator.export}`);
    }
  }
}

export function registerCasesShowCommand(cases: Command): void {
  cases
    .command('show <caseId>')
    .description('Show a fully resolved case definition by namespaced case ID')
    .option('--config <path>', 'Config path', '.gpcli/config.yaml')
    .option('--env-file <path>', 'Env file path', '.env')
    .action(async (caseId: string, options: { config: string; envFile: string }) => {
      try {
        loadEnvFile(options.envFile);
        const config = await loadObserverConfig(options.config);

        // Parse namespace
        const [packId, rawCaseId] = caseId.includes(':') ? caseId.split(':', 2) : [caseId, null];

        if (!packId || !rawCaseId) {
          console.error(pc.red('Invalid case ID format. Use \"pack:case-id\".'));
          process.exitCode = 1;
          return;
        }

        // Load pack graph (just this pack)
        const graph = await loadPackGraph(config.packs.directory, [packId]);

        // Resolve the pack
        const resolved = resolveInheritedPack(packId, graph);

        // Find the case
        const found = resolved.cases.find((c) => c.id === caseId);

        if (!found) {
          console.error(pc.red(`Case not found: ${caseId}`));
          process.exitCode = 1;
          return;
        }

        console.log(pc.bold(`Pack: ${resolved.name || packId}\n`));
        showCaseDetails(found);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(pc.red('cases show failed:'), msg);
        process.exitCode = 1;
      }
    });
}
