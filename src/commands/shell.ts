import type { Command } from 'commander';
import { emit } from '../contract/emit.js';
import { CLI_VERSION } from '../contract/version.js';
import { BUILTINS, Catalog } from '../shell/catalog.js';
import { runShell } from '../shell/shell.js';

export interface ShellCatalogData {
  interactive: false;
  commands: Array<{ command: string; description: string }>;
  builtins: Array<{ command: string; description: string }>;
}

export function shellCatalog(root: Command): ShellCatalogData {
  const catalog = new Catalog(root, { packIds: () => [], caseAddresses: () => [] });
  return {
    interactive: false,
    commands: catalog.leaves.map((leaf) => ({ command: `/${leaf.term}`, description: leaf.description })),
    builtins: BUILTINS.map((b) => ({ command: `/${b.name}${b.args ? ` ${b.args}` : ''}`, description: b.description }))
  };
}

/** Start the shell on this process's terminal. Also what a bare `globalpayments` runs. */
export async function startShell(root: Command): Promise<void> {
  const code = await runShell({ program: root, version: CLI_VERSION, input: process.stdin, output: process.stdout });
  process.exitCode = code;
}

export function registerShellCommand(program: Command): void {
  program
    .command('shell')
    .description('Open the interactive shell with slash commands, live completion and history')
    .option('--json', 'Describe the shell commands as a JSON envelope instead of starting the shell')
    .action(async (options: { json?: boolean }, command: Command) => {
      const root = command.parent ?? program;
      if (options.json) {
        emit('shell', { data: shellCatalog(root) }, { json: true });
        return;
      }
      await startShell(root);
    });
}
