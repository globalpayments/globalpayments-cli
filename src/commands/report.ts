import { Command } from 'commander';
import pc from 'picocolors';
import { readFile } from 'node:fs/promises';
import type { RunResult } from '../types/domain.js';

function renderTerminalReport(result: RunResult): void {
  console.log(pc.bold('Global Payments Certification Report'));
  console.log();

  console.log('Timestamp:', pc.cyan(result.timestamp));
  if (result.profile) {
    console.log('Profile:', pc.cyan(result.profile));
  }
  console.log('Packs:', pc.cyan(result.activePacks.join(', ')));
  console.log();

  console.log(pc.bold('Summary:'));
  console.log(`  ${pc.green(`${result.summary.pass} pass`)}, ${pc.red(`${result.summary.fail} fail`)}, ${pc.gray(`${result.summary.pending} pending`)}, ${pc.bold(result.summary.total.toString())} total`);
  console.log();

  // Group by pack
  const byPack = new Map<string, typeof result.cases>();
  for (const caze of result.cases) {
    if (!byPack.has(caze.packId)) {
      byPack.set(caze.packId, []);
    }
    byPack.get(caze.packId)!.push(caze);
  }

  for (const [packId, cases] of byPack) {
    const passCount = cases.filter((c) => c.status === 'pass').length;
    const failCount = cases.filter((c) => c.status === 'fail').length;
    const pendCount = cases.filter((c) => c.status === 'pending').length;

    console.log(pc.blue(`\n${packId}:`));
    console.log(`  ${pc.green(`${passCount} pass`)}, ${pc.red(`${failCount} fail`)}, ${pc.gray(`${pendCount} pending`)}`);

    for (const caze of cases) {
      const icon = caze.status === 'pass' ? pc.green('✓') : caze.status === 'fail' ? pc.red('✗') : pc.gray('○');
      const status = caze.status === 'pass' ? pc.green('PASS') : caze.status === 'fail' ? pc.red('FAIL') : pc.gray('PENDING');
      console.log(`    ${icon} ${caze.namespacedCaseId} [${status}] - ${caze.reason}`);

      if (caze.latestMatch) {
        console.log(`       Matched: ${caze.latestMatch.reference || caze.latestMatch.id}`);
      }
    }
  }

  console.log();
}

export function registerReportCommand(program: Command): void {
  program
    .command('report')
    .description('Read persisted result artifacts and print a summary')
    .option('--input <path>', 'Path to result JSON', '.gpcli/results/latest.json')
    .option('--format <type>', 'Output format (terminal|json)', 'terminal')
    .action(async (options: { input: string; format: string }) => {
      try {
        const content = await readFile(options.input, 'utf8');
        const result: RunResult = JSON.parse(content);

        if (options.format === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else {
          renderTerminalReport(result);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(pc.red('report failed:'), msg);
        process.exitCode = 1;
      }
    });
}
