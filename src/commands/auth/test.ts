import { Command } from 'commander';
import pc from 'picocolors';
import { ConfigLoadError, loadObserverConfig } from '../../config/load.js';
import {
  AuthFailureError,
  GpApiAuthProvider,
  InvalidCredentialsError,
  MalformedAuthResponseError,
  NetworkAuthError
} from '../../gpapi/auth.js';

function formatMetadata(metadata: Record<string, unknown>): string {
  return JSON.stringify(metadata, null, 2);
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Authentication related commands');

  auth
    .command('test')
    .description('Attempt GP API token retrieval and print safe metadata')
    .option('--config <path>', 'Config path', '.gpcli/config.yaml')
    .option('--env-file <path>', 'Env file path', '.env')
    .action(async (options: { config: string; envFile: string }) => {
      try {
        const config = await loadObserverConfig(options.config);
        const authProvider = new GpApiAuthProvider();
        const token = await authProvider.getToken({
          appId: config.auth.appId,
          appKey: config.auth.appKey,
          environment: config.environment,
          apiVersion: config.auth.apiVersion
        });

        console.log(pc.green('auth test successful'));
        console.log(
          formatMetadata({
            tokenReceived: token.accessToken.length > 0,
            tokenType: token.metadata.tokenType,
            expiresIn: token.metadata.expiresIn,
            expiresAt: token.metadata.expiresAt,
            scope: token.metadata.scope
          })
        );
      } catch (error: unknown) {
        if (error instanceof InvalidCredentialsError) {
          console.error(pc.red('auth failed: invalid credentials'));
          console.error(error.message);
          process.exitCode = 1;
          return;
        }

        if (error instanceof NetworkAuthError) {
          console.error(pc.red('auth failed: network error'));
          console.error(error.message);
          process.exitCode = 1;
          return;
        }

        if (error instanceof MalformedAuthResponseError || error instanceof AuthFailureError) {
          console.error(pc.red('auth failed'));
          console.error(error.message);
          process.exitCode = 1;
          return;
        }

        if (error instanceof ConfigLoadError) {
          console.error(pc.red('auth failed: invalid config'));
          console.error(error.message);
          process.exitCode = 1;
          return;
        }

        console.error(pc.red('auth failed: unexpected error'));
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
