import { Command } from 'commander';
import { t } from '../ui/index.js';
import { runCommand } from '../contract/emit.js';
import { buildManifest, type Manifest } from '../contract/manifest.js';

function renderManifest(manifest: Manifest): void {
  console.log(t.strong(`${manifest.tool} v${manifest.cliVersion}`));
  console.log(t.muted(manifest.description));
  console.log();

  console.log(t.strong('Commands'));
  for (const command of manifest.commands) {
    console.log(`  ${t.accent(command.usage)}`);
    console.log(`      ${t.muted(command.description)}`);
  }

  console.log();
  console.log(t.strong('Exit codes'));
  for (const exit of manifest.exitCodes) {
    console.log(`  ${t.accent(String(exit.code))} ${exit.name}${exit.retryable ? t.muted(' (retryable)') : ''}`);
    console.log(`      ${t.muted(exit.description)}`);
  }

  console.log();
  console.log(t.strong('Environment'));
  for (const variable of manifest.environment) {
    const flag = variable.required ? t.warning('required') : t.muted('optional');
    console.log(`  ${t.accent(variable.name)} (${flag})${variable.default ? t.muted(` default=${variable.default}`) : ''}`);
    console.log(`      ${t.muted(variable.description)}`);
  }

  console.log();
  console.log(t.strong('Workflows'));
  for (const workflow of manifest.workflows) {
    console.log(`  ${t.accent(workflow.id)} — ${workflow.goal}`);
    for (const step of workflow.steps) {
      console.log(`      ${t.command(step.command)}`);
      console.log(`          ${t.muted(step.purpose)}`);
    }
  }

  console.log();
  console.log(t.muted('Run with --json for the complete machine-readable contract.'));
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
          { reason: 'Verify credentials and connectivity before running anything.', command: 'globalpayments doctor --json' },
          { reason: 'Discover which certification suites are available.', command: 'globalpayments packs list --json' }
        ]
      }));
    });
}
