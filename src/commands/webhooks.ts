import { createHash, randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { statusMark, t } from '../ui/index.js';
import { runCommand } from '../contract/emit.js';
import { ERROR_CODES, GlobalPaymentsError } from '../contract/errors.js';
import { createApiSession } from '../core/api-session.js';
import {
  createLocalWebhookServer,
  listenOnLoopback,
  LocalWebhookDeliveryError,
  parseLocalForwardTarget
} from '../io/local-webhook.js';
import { parseDuration } from '../util/index.js';

const SYNTHETIC_EVENTS: Record<string, { type: string; status: string; result: string; message: string }> = {
  'transaction.captured': { type: 'SALE', status: 'CAPTURED', result: '00', message: 'SUCCEEDED' },
  'transaction.declined': { type: 'SALE', status: 'DECLINED', result: '05', message: 'DECLINED' },
  'transaction.refunded': { type: 'REFUND', status: 'REFUNDED', result: '00', message: 'SUCCEEDED' },
  'transaction.reversed': { type: 'SALE', status: 'REVERSED', result: '00', message: 'SUCCEEDED' },
  'transaction.preauthorized': { type: 'SALE', status: 'PREAUTHORIZED', result: '00', message: 'SUCCEEDED' }
};

export interface SyntheticWebhook {
  body: string;
  signature: string;
  payload: Record<string, unknown>;
}

export function createSyntheticWebhook(
  eventName: string,
  appId: string,
  appKey: string,
  now: Date = new Date()
): SyntheticWebhook {
  const event = SYNTHETIC_EVENTS[eventName];
  if (!event) {
    throw new GlobalPaymentsError(
      ERROR_CODES.E_USAGE,
      `Unsupported webhook event: ${eventName}.`,
      { details: { supportedEvents: Object.keys(SYNTHETIC_EVENTS) } }
    );
  }

  const timeCreated = now.toISOString();
  const payload = {
    id: `TRN_${randomUUID().replaceAll('-', '')}`,
    time_created: timeCreated,
    type: event.type,
    status: event.status,
    channel: 'CNP',
    capture_mode: 'AUTO',
    amount: '1000',
    currency: 'USD',
    country: 'US',
    merchant_id: 'MER_TEST_MERCHANT',
    merchant_name: 'Global Payments Local Webhook Test',
    account_id: 'TRA_TEST_ACCOUNT',
    account_name: 'sandbox',
    reference: `local-webhook-${randomUUID()}`,
    payment_method: {
      result: event.result,
      message: event.message,
      entry_mode: 'ECOM'
    },
    batch_id: '',
    action: {
      id: `ACT_${randomUUID().replaceAll('-', '')}`,
      type: 'STATUS_NOTIFICATION',
      time_created: timeCreated,
      result_code: 'SUCCESS',
      app_id: appId,
      app_name: 'globalpayments-cli-local-test'
    }
  };
  const body = JSON.stringify(payload);
  const signature = createHash('sha512').update(`${body}${appKey}`).digest('hex');
  return { body, signature, payload };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, `Invalid port: ${value}. Use a value from 1 to 65535.`);
  }
  return port;
}

function renderListenSummary(data: { port: number; forwarded: number; rejected: number; stoppedBy: string }): void {
  console.log(
    t.muted(`Webhook listener stopped (${data.stoppedBy}); forwarded=${data.forwarded}, rejected=${data.rejected}.`)
  );
}

export function registerWebhookCommands(program: Command): void {
  program
    .command('listen')
    .description('Receive local webhook POSTs and forward them to a localhost endpoint')
    .requiredOption('--forward-to <url>', 'Local receiver URL, e.g. http://localhost:3000/webhooks')
    .option('--port <port>', 'Local listener port', '4242')
    .option('--timeout <duration>', 'Stop after a duration (required with --json)')
    .option('--verify-signature', 'Validate POST signatures using the configured GP app key before forwarding')
    .option('--config <path>', 'Config file path used when verifying signatures')
    .option('--env-file <path>', 'Env file to load when verifying signatures', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { forwardTo: string; port: string; timeout?: string; verifySignature?: boolean; config?: string; envFile: string; json?: boolean }) => {
      await runCommand('listen', { json: options.json }, async (reportProgress) => {
        if (options.json && !options.timeout) {
          throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, '`globalpayments listen --json` requires --timeout.');
        }

        const forwardTo = parseLocalForwardTarget(options.forwardTo);
        const port = parsePort(options.port);
        const timeoutMs = options.timeout === undefined ? undefined : parseDuration(options.timeout);
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
          throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, '--timeout must be a positive duration.');
        }

        const appKey = options.verifySignature
          ? (await createApiSession({ configPath: options.config, envFile: options.envFile })).authInput.appKey
          : undefined;
        let forwarded = 0;
        let rejected = 0;
        const server = createLocalWebhookServer({
          forwardTo,
          ...(appKey !== undefined ? { appKey } : {}),
          onForward: (status) => {
            forwarded += 1;
            reportProgress(`Forwarded webhook to ${forwardTo.href}; receiver responded ${status}.`);
          },
          onReject: (reason) => {
            rejected += 1;
            reportProgress(reason);
          },
          onError: (error) => {
            rejected += 1;
            reportProgress(`Webhook forwarding failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });

        let listeningPort: number;
        try {
          listeningPort = await listenOnLoopback(server, port);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EADDRINUSE' || code === 'EACCES') {
            throw new GlobalPaymentsError(
              ERROR_CODES.E_USAGE,
              code === 'EADDRINUSE'
                ? `Port ${port} is already in use on 127.0.0.1.`
                : `Not allowed to listen on port ${port}.`,
              { remediation: 'Pass a free port with --port, and the same --port to `globalpayments trigger`.', cause: error }
            );
          }
          throw error;
        }
        const forwardPort = Number(forwardTo.port || (forwardTo.protocol === 'https:' ? 443 : 80));
        if (forwardPort === listeningPort) {
          server.close();
          throw new GlobalPaymentsError(
            ERROR_CODES.E_USAGE,
            `--forward-to points back at this listener (port ${listeningPort}), so every event would be forwarded to itself.`,
            { remediation: 'Forward to the port your app listens on, e.g. http://localhost:3000/webhooks, and keep --port different.' }
          );
        }
        reportProgress(`Listening on http://127.0.0.1:${listeningPort}; forwarding to ${forwardTo.href}.`);

        let stoppedBy = 'signal';
        let timer: NodeJS.Timeout | undefined;
        const close = (): void => {
          if (server.listening) server.close();
        };
        const stop = (): void => close();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);

        const closed = new Promise<void>((resolve) => server.once('close', resolve));
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            stoppedBy = 'timeout';
            close();
          }, timeoutMs);
        }

        try {
          await closed;
        } finally {
          if (timer) clearTimeout(timer);
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        }

        const data = { port: listeningPort, forwardTo: forwardTo.href, forwarded, rejected, stoppedBy };
        return {
          data,
          render: renderListenSummary,
          nextActions: [
            { reason: 'Send a signed synthetic event to the local listener.', command: 'globalpayments trigger transaction.captured' }
          ]
        };
      });
    });

  program
    .command('trigger <event>')
    .description('Send a signed synthetic webhook event to the local listener')
    .option('--port <port>', 'Local listener port', '4242')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (event: string, options: { port: string; config?: string; envFile: string; json?: boolean }) => {
      await runCommand('trigger', { json: options.json }, async () => {
        const { config, authInput } = await createApiSession({
          configPath: options.config,
          envFile: options.envFile
        });
        if (config.environment !== 'sandbox') {
          throw new GlobalPaymentsError(
            ERROR_CODES.E_CONFIG_INVALID,
            'Synthetic webhook triggers require sandbox credentials.',
            { details: { environment: config.environment } }
          );
        }

        const port = parsePort(options.port);
        const webhook = createSyntheticWebhook(event, authInput.appId, authInput.appKey);
        let response: Response;
        try {
          response = await fetch(`http://127.0.0.1:${port}/`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-gp-signature': webhook.signature
            },
            body: webhook.body,
            signal: AbortSignal.timeout(10_000),
            redirect: 'error'
          });
        } catch (error) {
          throw new LocalWebhookDeliveryError(
            'Unable to deliver the synthetic event to the local webhook listener.',
            undefined,
            { cause: error }
          );
        }

        const data = { event, port, status: response.status, payload: webhook.payload };
        if (!response.ok) {
          throw new LocalWebhookDeliveryError(`Local webhook receiver returned HTTP ${response.status}.`, response.status);
        }

        return {
          data,
          render: (result) => {
            console.log(statusMark('pass'), `Triggered ${result.event}; local receiver responded ${result.status}.`);
          }
        };
      });
    });
}
