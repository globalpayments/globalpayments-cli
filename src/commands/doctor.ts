import { Command } from 'commander';
import pc from 'picocolors';
import { ConfigLoadError, loadObserverConfig } from '../config/load.js';
import {
  AuthFailureError,
  GpApiAuthProvider,
  InvalidCredentialsError,
  MalformedAuthResponseError,
  NetworkAuthError
} from '../gpapi/auth.js';
import { listBuiltinPackIds } from '../core/builtin-packs.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Validate local configuration and auth readiness')
    .option('--config <path>', 'Config path (optional; can use env vars only)')
    .option('--env-file <path>', 'Env file path', '.env')
    .action(async (options: { config?: string; envFile: string }) => {
      try {
        console.log(pc.cyan('doctor'), 'Checking configuration and authentication...\n');

        // Load config
        let config;
        try {
          config = await loadObserverConfig(options.config);
          console.log(pc.green('✓'), 'Config loaded:', pc.cyan(options.config));
        } catch (error) {
          if (error instanceof ConfigLoadError) {
            console.error(pc.red('✗'), 'Failed to load config:', error.message);
            process.exitCode = 1;
            return;
          }
          const msg = error instanceof Error ? error.message : String(error);
          console.error(pc.red('✗'), 'Failed to load config:', msg);
          process.exitCode = 1;
          return;
        }

        // Check environment
        console.log();
        console.log('Environment:', pc.blue(config.environment));
        if (config.account?.accountName) {
          console.log('Account:', pc.blue(config.account.accountName));
        }

        // Check auth credentials
        console.log();
        if (!config.auth.appId) {
          console.error(pc.red('✗'), 'Missing auth.appId in config');
          process.exitCode = 1;
          return;
        }
        if (!config.auth.appKey) {
          console.error(pc.red('✗'), 'Missing auth.appKey in config');
          process.exitCode = 1;
          return;
        }
        console.log(pc.green('✓'), 'Auth credentials configured');

        // Attempt token retrieval
        console.log();
        console.log('Attempting token retrieval...');
        const authProvider = new GpApiAuthProvider();
        const token = await authProvider.getToken({
          appId: config.auth.appId,
          appKey: config.auth.appKey,
          environment: config.environment,
          apiVersion: config.auth.apiVersion
        });

        console.log(pc.green('✓'), 'Successfully retrieved access token');
        console.log('  Token type:', pc.blue(token.metadata.tokenType));
        console.log('  Expires in:', pc.blue(`${token.metadata.expiresIn}s`));
        console.log('  Scope:', pc.blue(token.metadata.scope));

        console.log();
        console.log(pc.green('✓'), 'All checks passed. Ready for certification runs.');

        // List available bundled packs
        const builtinPacks = await listBuiltinPackIds();
        if (builtinPacks.length > 0) {
          console.log();
          console.log(pc.cyan('Available bundled cert suites (use with --cert or --pack):'));
          for (const id of builtinPacks) {
            console.log(`  ${pc.yellow(id)}`);
          }
        }
      } catch (error: unknown) {
        console.log();
        if (error instanceof InvalidCredentialsError) {
          console.error(pc.red('✗'), 'Invalid credentials (app ID or app key)');
          console.error('  Details:', error.message);
          process.exitCode = 1;
          return;
        }
        if (error instanceof NetworkAuthError) {
          console.error(pc.red('✗'), 'Network error during authentication');
          console.error('  Details:', error.message);
          process.exitCode = 1;
          return;
        }
        if (error instanceof MalformedAuthResponseError) {
          console.error(pc.red('✗'), 'Unexpected response from GP API');
          console.error('  Details:', error.message);
          process.exitCode = 1;
          return;
        }
        if (error instanceof AuthFailureError) {
          console.error(pc.red('✗'), 'Authentication failed');
          console.error('  Details:', error.message);
          process.exitCode = 1;
          return;
        }

        const msg = error instanceof Error ? error.message : String(error);
        console.error(pc.red('✗'), 'Unexpected error:', msg);
        process.exitCode = 1;
      }
    });
}
