import { Command } from 'commander';
import { registerInitCommand } from './commands/init.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerAuthCommands } from './commands/auth/test.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerRunCommand } from './commands/run.js';
import { registerReportCommand } from './commands/report.js';
import { registerCasesCommands } from './commands/cases/list.js';

export function buildCli(): Command {
  const program = new Command();

  program
    .name('gpcli')
    .description('Global Payments certification observer CLI')
    .version('0.1.0');

  registerInitCommand(program);
  registerDoctorCommand(program);
  registerAuthCommands(program);
  registerWatchCommand(program);
  registerRunCommand(program);
  registerReportCommand(program);
  registerCasesCommands(program);

  return program;
}
