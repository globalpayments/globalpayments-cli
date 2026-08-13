import { Command } from 'commander';
import pc from 'picocolors';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { listBuiltinPackIds } from '../core/builtin-packs.js';

const STARTER_ENV = `# Global Payments API Credentials
# Set these in your environment or in a .env file loaded by your shell.
GP_API_APP_ID=your_app_id_here
GP_API_APP_KEY=your_app_key_here

# Optional: override target environment (default: sandbox)
# GP_ENVIRONMENT=sandbox

# Optional: restrict matching to a specific account
# GP_ACCOUNT_NAME=your_account_name
`;

const STARTER_CONFIG = `# gp-cli configuration (optional)
# Most settings have sensible defaults. Only override what you need.
# Credentials are read from environment variables by default — you do not
# need this file unless you want to customize polling, output, or add local packs.

version: 1
environment: sandbox   # or: production

auth:
  mode: app-credentials
  appId: \${GP_API_APP_ID}
  appKey: \${GP_API_APP_KEY}

# Uncomment to restrict matching to a specific GP account:
# account:
#   accountName: \${GP_ACCOUNT_NAME}

# Uncomment to tune polling behaviour:
# polling:
#   intervalMs: 3000
#   lookbackMinutes: 10

# Uncomment to add local packs (in addition to bundled ones):
# packs:
#   directory: ./packs
`;

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Generate a minimal .env.example (and optional config) for gp-cli')
    .option('--dir <path>', 'Output directory', '.')
    .option('--with-config', 'Also generate an annotated config.yaml override file')
    .action(async (options: { dir: string; withConfig?: boolean }) => {
      try {
        const outputDir = options.dir;
        await mkdir(outputDir, { recursive: true });

        // Always write .env.example
        const envPath = path.join(outputDir, '.env.example');
        if (!existsSync(envPath)) {
          await writeFile(envPath, STARTER_ENV, 'utf8');
          console.log(pc.green('✓'), 'Created:', pc.cyan(envPath));
        } else {
          console.log(pc.gray('–'), 'Already exists (skipped):', pc.cyan(envPath));
        }

        // Optionally write config.yaml
        if (options.withConfig) {
          const configPath = path.join(outputDir, 'gpcli.config.yaml');
          if (!existsSync(configPath)) {
            await writeFile(configPath, STARTER_CONFIG, 'utf8');
            console.log(pc.green('✓'), 'Created:', pc.cyan(configPath));
          } else {
            console.log(pc.gray('–'), 'Already exists (skipped):', pc.cyan(configPath));
          }
        }

        // Show available cert suites
        const builtinPacks = await listBuiltinPackIds();

        console.log();
        console.log(pc.cyan('Next steps:'));
        console.log(`1. Copy ${pc.cyan('.env.example')} to ${pc.cyan('.env')} and fill in your GP API credentials`);
        console.log(`2. Run ${pc.yellow('gpcli doctor')} to verify your setup`);
        if (builtinPacks.length > 0) {
          console.log(`3. Run a cert suite:  ${pc.yellow(`gpcli run --cert ${builtinPacks[0]}`)}`);
          console.log();
          console.log(pc.cyan('Available bundled cert suites:'));
          for (const id of builtinPacks) {
            console.log(`  ${pc.yellow(id)}`);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(pc.red('init failed:'), msg);
        process.exitCode = 1;
      }
    });
}

