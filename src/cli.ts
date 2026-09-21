import { Command } from 'commander';
import { CLI_VERSION } from './contract/version.js';
import { EXIT_CODES } from './contract/exit-codes.js';
import { registerInitCommand } from './commands/init.js';
import { registerExplainCommand } from './commands/explain.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerAuthCommands } from './commands/auth/test.js';
import { registerPacksCommands } from './commands/packs.js';
import { registerCasesCommands } from './commands/cases/index.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerRunCommand } from './commands/run.js';
import { registerReportCommand } from './commands/report.js';

/**
 * Assemble the CLI.
 *
 * Registration order is the order commands appear in `--help` and in
 * `globalpayments explain`, so it runs orient -> discover -> execute -> review, which is the
 * order a caller encountering the tool for the first time needs them in.
 */
export function buildCli(): Command {
  const program = new Command();

  program
    .name('globalpayments')
    .description(
      'Observer-only certification CLI for Global Payments. Polls the GP API for transactions you have already sent, matches them to certification cases, and reports latest-match-wins results. Run `globalpayments explain --json` for the full machine-readable contract.'
    )
    .version(CLI_VERSION);

  // Orient
  registerExplainCommand(program);
  registerInitCommand(program);
  registerDoctorCommand(program);
  registerAuthCommands(program);

  // Discover
  registerPacksCommands(program);
  registerCasesCommands(program);

  // Execute
  registerRunCommand(program);
  registerWatchCommand(program);

  // Review
  registerReportCommand(program);

  return program;
}

/**
 * Run the CLI, routing commander's own failures through the exit-code contract.
 *
 * Commander handles `--help`, `--version`, unknown options, and missing arguments
 * itself, exiting with its own codes. Left alone, that punches a hole in the
 * contract: a caller that typos a flag gets exit 1, which the taxonomy reserves
 * for "required cases are failing" — making an invocation mistake
 * indistinguishable from a certification result. `exitOverride` maps those onto
 * EXIT_CODES.USAGE (2), while preserving 0 for help and version, which
 * are successful outcomes rather than errors.
 *
 * Commands set `process.exitCode` via `emit()` rather than exiting directly, so
 * the final exit honours whatever the command already decided.
 */
function applyExitContract(command: Command): void {
  command.exitOverride((error) => {
    const informational =
      error.code === 'commander.help' ||
      error.code === 'commander.helpDisplayed' ||
      error.code === 'commander.version';
    process.exit(informational ? EXIT_CODES.OK : EXIT_CODES.USAGE);
  });

  for (const child of command.commands) {
    applyExitContract(child);
  }
}

export async function runCli(argv: string[]): Promise<never> {
  const program = buildCli();
  applyExitContract(program);

  await program.parseAsync(argv);

  process.exit(typeof process.exitCode === 'number' ? process.exitCode : EXIT_CODES.OK);
}
