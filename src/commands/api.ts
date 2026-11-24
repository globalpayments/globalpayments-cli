import { Command } from 'commander';
import pc from 'picocolors';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { runCommand } from '../contract/emit.js';
import { ERROR_CODES, GlobalPaymentsError } from '../contract/errors.js';
import { createApiSession } from '../core/api-session.js';
import { environmentBaseUrl } from '../gpapi/auth.js';
import { requestGpApi, type GpApiMethod, type GpApiResponse } from '../gpapi/request.js';

interface ApiCommandOptions {
  config?: string;
  envFile: string;
  json?: boolean;
}

interface ApiResult extends GpApiResponse {
  method: GpApiMethod;
  path: string;
  environment: string;
}

function webhookUrl(value: string, option: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, `${option} must be an HTTPS URL.`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    url.protocol !== 'https:' || !hostname || url.username || url.password || url.hash ||
    hostname === 'localhost' || hostname.endsWith('.localhost') || isIP(hostname) !== 0
  ) {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, `${option} must be an HTTPS URL with a non-local DNS hostname and no credentials or fragment.`);
  }
  return url.href;
}

export function buildTestPayRequest(options: {
  statusUrl: string;
  returnUrl: string;
  accountName: string;
  amount: string;
  currency: string;
  country: string;
}): Record<string, unknown> {
  if (!/^[1-9]\d*$/.test(options.amount)) {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, '--amount must be a positive whole number in minor currency units.');
  }
  if (!/^[A-Z]{3}$/.test(options.currency) || !/^[A-Z]{2}$/.test(options.country)) {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, '--currency and --country must be uppercase ISO codes.');
  }
  if (!options.accountName.trim()) {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, '--account-name cannot be empty.');
  }
  return {
    account_name: options.accountName,
    channel: 'CNP',
    type: 'SALE',
    amount: options.amount,
    currency: options.currency,
    country: options.country,
    reference: `cli-testpay-${randomUUID()}`,
    payment_method: { name: 'Sandbox Test', entry_mode: 'ECOM', apm: { provider: 'testpay' } },
    notifications: {
      status_url: webhookUrl(options.statusUrl, '--status-url'),
      return_url: webhookUrl(options.returnUrl, '--return-url')
    }
  };
}

async function parsePostBody(data?: string, dataFile?: string): Promise<unknown> {
  if (data !== undefined && dataFile !== undefined) {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, 'Pass either --data or --data-file, not both.');
  }

  if (data === undefined && dataFile === undefined) {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_USAGE,
      'POST requires a JSON body. Pass it with --data <json> or --data-file <path>.'
    );
  }

  const raw = dataFile === undefined ? data! : await readFile(dataFile, 'utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, 'The POST body is not valid JSON.', {
        details: { dataFile }
      });
    }
    throw error;
  }
}

function renderApiResult(result: ApiResult): void {
  console.log(pc.green(`${result.method} ${result.path} → ${result.status} (${result.environment})`));
  if (result.body !== undefined) {
    console.log(JSON.stringify(result.body, null, 2));
  }
}

async function executeApiRequest(
  method: GpApiMethod,
  requestPath: string,
  options: ApiCommandOptions,
  body?: unknown
): Promise<ApiResult> {
  const { config, authInput, authProvider } = await createApiSession({
    configPath: options.config,
    envFile: options.envFile
  });
  if (method === 'POST' && config.environment !== 'sandbox') {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_CONFIG_INVALID,
      'API writes are sandbox-only; no request was sent.',
      {
        details: { environment: config.environment },
        remediation: 'Configure GP_API_ENVIRONMENT=sandbox and use sandbox credentials before sending a POST request.'
      }
    );
  }

  const response = await requestGpApi(
    {
      authProvider,
      authInput,
      baseUrl: environmentBaseUrl(config.environment)
    },
    { method, path: requestPath, ...(method === 'POST' ? { body } : {}) }
  );

  return {
    method,
    path: requestPath,
    environment: config.environment,
    ...response
  };
}

export function registerApiCommands(program: Command): void {
  const api = program.command('api').description('Make authenticated requests to the GP API');

  api
    .command('get <path>')
    .description('GET a GP API resource using the configured sandbox or production credentials')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (requestPath: string, options: ApiCommandOptions) => {
      await runCommand<ApiResult>('api.get', { json: options.json }, async () => {
        const data = await executeApiRequest('GET', requestPath, options);
        return {
          data,
          render: renderApiResult,
          nextActions: [{ reason: 'Inspect the full command contract.', command: 'globalpayments explain --json' }]
        };
      });
    });

  api
    .command('post <path>')
    .description('POST JSON to the GP API; writes are restricted to the sandbox environment')
    .option('--data <json>', 'Request body as a JSON string')
    .option('--data-file <path>', 'Read the JSON request body from a file')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (requestPath: string, options: ApiCommandOptions & { data?: string; dataFile?: string }) => {
      await runCommand<ApiResult>('api.post', { json: options.json }, async () => {
        const body = await parsePostBody(options.data, options.dataFile);
        const data = await executeApiRequest('POST', requestPath, options, body);
        return {
          data,
          render: renderApiResult,
          nextActions: [{ reason: 'Inspect the request and certification workflows.', command: 'globalpayments explain --json' }]
        };
      });
    });

  const transactions = program.command('transactions').description('Inspect transactions in the configured GP account');

  transactions
    .command('get <id>')
    .description('Fetch one transaction by its GP transaction ID')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (id: string, options: ApiCommandOptions) => {
      await runCommand<ApiResult>('transactions.get', { json: options.json }, async () => {
        const data = await executeApiRequest('GET', `/transactions/${encodeURIComponent(id)}`, options);
        return {
          data,
          render: renderApiResult,
          nextActions: [
            { reason: 'Inspect action history for the request.', command: 'globalpayments logs tail --status 4xx' }
          ]
        };
      });
    });

  transactions
    .command('testpay')
    .description('Initiate a real sandbox TestPay sale with a configured status webhook')
    .requiredOption('--status-url <url>', 'Approved public HTTPS endpoint for GP status notifications')
    .requiredOption('--return-url <url>', 'Approved public HTTPS endpoint for the browser return')
    .option('--account-name <name>', 'GP transaction processing account', 'transaction_processing')
    .option('--amount <minor-units>', 'Positive amount in minor currency units', '100')
    .option('--currency <code>', 'ISO currency code', 'EUR')
    .option('--country <code>', 'ISO country code', 'IE')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: ApiCommandOptions & {
      statusUrl: string; returnUrl: string; accountName: string; amount: string; currency: string; country: string;
    }) => {
      await runCommand<ApiResult>('transactions.testpay', { json: options.json }, async () => {
        const body = buildTestPayRequest(options);
        const data = await executeApiRequest('POST', '/transactions', options, body);
        return {
          data,
          render: (result) => {
            renderApiResult(result);
            console.log('Complete the returned TestPay checkout; a successful request does not confirm webhook delivery.');
          }
        };
      });
    });
}
