import { Command } from 'commander';
import pc from 'picocolors';
import { runCommand } from '../contract/emit.js';
import { buildManifest, type Manifest } from '../contract/manifest.js';

function renderManifest(manifest: Manifest): void {
  console.log(pc.bold(`${manifest.tool} v${manifest.cliVersion}`));
  console.log(pc.gray(manifest.description));
  console.log();

  console.log(pc.bold('Commands'));
  for (const command of manifest.commands) {
    console.log(`  ${pc.cyan(command.usage)}`);
    console.log(`      ${pc.gray(command.description)}`);
  }

  console.log();
  console.log(pc.bold('Exit codes'));
  for (const exit of manifest.exitCodes) {
    console.log(`  ${pc.yellow(String(exit.code))} ${exit.name}${exit.retryable ? pc.gray(' (retryable)') : ''}`);
    console.log(`      ${pc.gray(exit.description)}`);
  }

  console.log();
  console.log(pc.bold('Environment'));
  for (const variable of manifest.environment) {
    const flag = variable.required ? pc.yellow('required') : pc.gray('optional');
    console.log(`  ${pc.cyan(variable.name)} (${flag})${variable.default ? pc.gray(` default=${variable.default}`) : ''}`);
    console.log(`      ${pc.gray(variable.description)}`);
  }

  console.log();
  console.log(pc.bold('Workflows'));
  for (const workflow of manifest.workflows) {
    console.log(`  ${pc.cyan(workflow.id)} — ${workflow.goal}`);
    for (const step of workflow.steps) {
      console.log(`      ${pc.yellow(step.command)}`);
      console.log(`          ${pc.gray(step.purpose)}`);
    }
  }

  console.log();
  console.log(pc.gray('Run with --json for the complete machine-readable contract.'));
}

/**
 * Self-description.
 *
 * A single call returns the complete interface contract: every command and flag,
 * every exit code, every error code with its remediation, every environment input,
 * the domain concepts, and canonical workflows. This exists so an automated caller
 * can build an accurate model of the tool without reading prose documentation or
 * probing commands to discover their behaviour.
 */
export function registerExplainCommand(program: Command): void {
  program
    .command('explain')
    .description('Describe the entire CLI contract: commands, exit codes, error codes, concepts, and workflows')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { json?: boolean }) => {
      await runCommand<Manifest>('explain', { json: options.json }, async () => ({
        data: buildManifest(program),
        render: renderManifest,
        nextActions: [
          { reason: 'Verify credentials and connectivity before running anything.', command: 'gpcli doctor --json' },
          { reason: 'Discover which certification suites are available.', command: 'gpcli packs list --json' }
        ]
      }));
    });
}
