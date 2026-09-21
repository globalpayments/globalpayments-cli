import { Command } from 'commander';
import pc from 'picocolors';
import { runCommand } from '../../contract/emit.js';
import { GlobalPaymentsError, ERROR_CODES } from '../../contract/errors.js';
import { loadObserverConfig } from '../../config/load.js';
import { loadEnvFile } from '../../config/env.js';
import { GpApiAuthProvider, environmentBaseUrl } from '../../gpapi/auth.js';

export interface AuthTestData {
  authenticated: true;
  environment: string;
  baseUrl: string;
  apiVersion: string;
  token: {
    type?: string;
    expiresIn?: number;
    expiresAt?: string;
    scope?: string;
  };
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication commands');

  auth
    .command('test')
    .description('Exchange credentials for a GP API token and report safe token metadata')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { config?: string; envFile: string; json?: boolean }) => {
      await runCommand<AuthTestData>('auth.test', { json: options.json }, async () => {
        loadEnvFile(options.envFile);
        const config = await loadObserverConfig(options.config);

        if (!config.auth.appId || !config.auth.appKey) {
          throw new GlobalPaymentsError(
            ERROR_CODES.E_AUTH_MISSING_CREDENTIALS,
            'GP API credentials are not configured (auth.appId / auth.appKey are empty).'
          );
        }

        const token = await new GpApiAuthProvider().getToken({
          appId: config.auth.appId,
          appKey: config.auth.appKey,
          environment: config.environment,
          apiVersion: config.auth.apiVersion
        });

        const data: AuthTestData = {
          authenticated: true,
          environment: config.environment,
          baseUrl: environmentBaseUrl(config.environment),
          apiVersion: config.auth.apiVersion,
          token: {
            ...(token.metadata.tokenType !== undefined ? { type: token.metadata.tokenType } : {}),
            ...(token.metadata.expiresIn !== undefined ? { expiresIn: token.metadata.expiresIn } : {}),
            ...(token.metadata.expiresAt !== undefined ? { expiresAt: token.metadata.expiresAt } : {}),
            ...(token.metadata.scope !== undefined ? { scope: token.metadata.scope } : {})
          }
        };

        return {
          data,
          render: (value) => {
            console.log(pc.green('✓'), 'Authenticated against', pc.cyan(value.baseUrl));
            console.log(pc.gray(`  environment=${value.environment} apiVersion=${value.apiVersion}`));
            console.log(
              pc.gray(
                `  token type=${value.token.type ?? 'unknown'} expiresIn=${value.token.expiresIn ?? 'unknown'}s`
              )
            );
          },
          nextActions: [
            { reason: 'Run the full readiness report.', command: 'globalpayments doctor --json' }
          ]
        };
      });
    });
}
