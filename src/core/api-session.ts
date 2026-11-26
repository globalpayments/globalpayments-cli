import { loadEnvFile } from '../config/env.js';
import { loadObserverConfig } from '../config/load.js';
import { GlobalPaymentsError, ERROR_CODES } from '../contract/errors.js';
import { GpApiAuthProvider, type AuthInput } from '../gpapi/auth.js';

export interface ApiSessionOptions {
  configPath?: string;
  envFile?: string;
}

export async function createApiSession(options: ApiSessionOptions): Promise<{
  config: Awaited<ReturnType<typeof loadObserverConfig>>;
  authInput: AuthInput;
  authProvider: GpApiAuthProvider;
}> {
  loadEnvFile(options.envFile ?? '.env');
  const config = await loadObserverConfig(options.configPath);

  if (!config.auth.appId || !config.auth.appKey) {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_AUTH_MISSING_CREDENTIALS,
      'GP API credentials are not configured (auth.appId / auth.appKey are empty).'
    );
  }

  return {
    config,
    authInput: {
      appId: config.auth.appId,
      appKey: config.auth.appKey,
      environment: config.environment,
      apiVersion: config.auth.apiVersion
    },
    authProvider: new GpApiAuthProvider()
  };
}
