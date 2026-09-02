import { Command } from 'commander';
import pc from 'picocolors';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runCommand } from '../contract/emit.js';
import { listBuiltinPackIds } from '../core/builtin-packs.js';
import { DEFAULT_CONFIG_PATH } from '../config/load.js';

const STARTER_ENV = `# Global Payments API credentials.
# globalpayments reads these from the environment; a .env file is loaded automatically.
GP_API_APP_ID=your_app_id_here
GP_API_APP_KEY=your_app_key_here

# Optional: target environment (default: sandbox)
# GP_ENVIRONMENT=sandbox

# Optional: restrict matching to a single GP account
# GP_ACCOUNT_NAME=your_account_name

# Optional: pin the GP API version (default: 2021-03-22)
# GP_API_VERSION=2021-03-22
`;

const STARTER_CONFIG = `# globalpayments configuration — entirely optional.
# Credentials come from the environment, so this file is only needed to customise
# polling, output, or to register your own certification packs.
# Run \`globalpayments explain --json\` for the full contract.

version: 1
environment: sandbox   # or: production

auth:
  mode: app-credentials
  appId: \${GP_API_APP_ID}
  appKey: \${GP_API_APP_KEY}

# Restrict matching to one GP account:
# account:
#   accountName: \${GP_API_ACCOUNT_NAME}

# Tune the polling window. Transactions older than the window are invisible.
# polling:
#   intervalMs: 3000
#   lookbackMinutes: 10
#   overlapSeconds: 30

# Register local packs, searched after the bundled ones:
# packs:
#   directory: ./packs

# Name reusable pack sets, then select with --profile:
# profiles:
#   smoke:
#     packs: [global-core]
`;

export interface InitFileResult {
  path: string;
  created: boolean;
  reason: string;
}

export interface InitData {
  directory: string;
  files: InitFileResult[];
  packsAvailable: string[];
}

async function writeIfAbsent(filePath: string, contents: string): Promise<InitFileResult> {
  if (existsSync(filePath)) {
    return { path: filePath, created: false, reason: 'Already exists; left untouched.' };
  }
  await writeFile(filePath, contents, 'utf8');
  return { path: filePath, created: true, reason: 'Created.' };
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffold a starter .env.example and, optionally, an annotated config file')
    .option('--dir <path>', 'Directory to write into', '.')
    .option('--with-config', 'Also write an annotated globalpayments.config.yaml')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { dir: string; withConfig?: boolean; json?: boolean }) => {
      await runCommand<InitData>('init', { json: options.json }, async () => {
        await mkdir(options.dir, { recursive: true });

        const files: InitFileResult[] = [await writeIfAbsent(path.join(options.dir, '.env.example'), STARTER_ENV)];

        if (options.withConfig) {
          files.push(await writeIfAbsent(path.join(options.dir, 'globalpayments.config.yaml'), STARTER_CONFIG));
        }

        const packsAvailable = await listBuiltinPackIds();

        return {
          data: { directory: options.dir, files, packsAvailable } satisfies InitData,
          render: (data) => {
            for (const file of data.files) {
              const icon = file.created ? pc.green('✓') : pc.gray('–');
              console.log(`${icon} ${pc.cyan(file.path)} ${pc.gray(file.reason)}`);
            }
          },
          nextActions: [
            {
              reason: 'Copy the example to .env and fill in your GP API credentials.',
              command: `cp ${path.join(options.dir, '.env.example')} ${path.join(options.dir, '.env')}`
            },
            { reason: 'Confirm credentials and connectivity.', command: 'globalpayments doctor --json' },
            {
              reason: 'Evaluate a bundled certification suite.',
              command: `globalpayments run --cert ${packsAvailable[0] ?? '<packId>'} --json`
            }
          ]
        };
      });
    });
}
