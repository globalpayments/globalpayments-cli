import { Command } from 'commander';
import { padEnd, statusMark, stringWidth, sym, t, wrapText } from '../ui/index.js';
import { terminalColumns } from '../ui/capabilities.js';
import { withSpinner } from '../ui/spinner.js';
import { inlineCode } from '../ui/text.js';
import { existsSync } from 'node:fs';
import { runCommand } from '../contract/emit.js';
import { GlobalPaymentsError, ERROR_CODES, toGlobalPaymentsError, type ErrorCode } from '../contract/errors.js';
import { DEFAULT_CONFIG_PATH, loadObserverConfig } from '../config/load.js';
import { loadEnvFile } from '../config/env.js';
import { GpApiAuthProvider, environmentBaseUrl } from '../gpapi/auth.js';
import { builtinPacksDirExists, listBuiltinPackIds, resolveBuiltinPacksDir } from '../core/builtin-packs.js';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** Present only when status is 'fail'. Stable across releases. */
  errorCode?: string;
  remediation?: string;
}

export interface DoctorData {
  ready: boolean;
  environment?: string;
  baseUrl?: string;
  accountName?: string;
  configSource: 'file' | 'environment';
  configPath?: string;
  checks: DoctorCheck[];
  packsAvailable: string[];
}

function pass(id: string, title: string, detail: string): DoctorCheck {
  return { id, title, status: 'pass', detail };
}

function fail(id: string, title: string, detail: string, error: GlobalPaymentsError): DoctorCheck {
  return { id, title, status: 'fail', detail, errorCode: error.code, remediation: error.remediation };
}

function renderDoctor(data: DoctorData): void {
  const width = terminalColumns();
  const titleWidth = Math.max(...data.checks.map((check) => stringWidth(check.title)));
  const indent = 4 + titleWidth + 3;
  const detailWidth = Math.max(24, width - indent);
  const pad = ' '.repeat(indent);
  console.log();
  console.log(`${t.heading('Readiness')}${data.environment ? ` ${t.muted(`${sym().dot} ${data.environment}`)}` : ''}`);
  console.log();
  for (const check of data.checks) {
    const mark = statusMark(check.status === 'pass' ? 'pass' : check.status === 'fail' ? 'fail' : 'skip');
    const [first = '', ...rest] = wrapText(check.detail, detailWidth);
    console.log(`  ${mark} ${padEnd(check.title, titleWidth)}   ${t.muted(first)}`);
    for (const line of rest) console.log(`${pad}${t.muted(line)}`);
    if (check.remediation) {
      const [fixFirst = '', ...fixRest] = wrapText(check.remediation, detailWidth - 5);
      console.log(`${pad}${t.warning('fix:')} ${inlineCode(fixFirst)}`);
      for (const line of fixRest) console.log(`${pad}     ${inlineCode(line)}`);
    }
  }
  console.log();
  console.log(
    data.ready
      ? `${statusMark('pass')} ${t.success('Ready for certification runs.')}`
      : `${statusMark('fail')} ${t.danger('Not ready.')} ${t.muted('Fix the first failing check and run doctor again.')}`
  );
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check configuration, credentials, and GP API reachability as a structured readiness report')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { config?: string; envFile: string; json?: boolean }) => {
      await runCommand<DoctorData>('doctor', { json: options.json }, async () => {
        const checks: DoctorCheck[] = [];
        const packsAvailable = await listBuiltinPackIds();

        // 1. Env file
        const envFile = options.envFile;
        if (existsSync(envFile)) {
          loadEnvFile(envFile);
          checks.push(pass('env-file', 'Env file loaded', `Loaded ${envFile}.`));
        } else {
          checks.push({
            id: 'env-file',
            title: 'Env file',
            status: 'skip',
            detail: `${envFile} not present; reading credentials from the process environment instead.`
          });
        }

        // 2. Config
        const configPath = options.config ?? (existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : undefined);
        const configSource: 'file' | 'environment' = configPath ? 'file' : 'environment';

        let config;
        try {
          config = await loadObserverConfig(options.config);
          checks.push(
            pass(
              'config',
              'Configuration resolved',
              configPath ? `Loaded from ${configPath}.` : 'No config file; derived entirely from environment variables.'
            )
          );
        } catch (error) {
          const gpError = toGlobalPaymentsError(error);
          checks.push(fail('config', 'Configuration resolved', gpError.message, gpError));
          return {
            data: {
              ready: false,
              configSource,
              configPath,
              checks,
              packsAvailable
            } satisfies DoctorData,
            error: gpError
          };
        }

        const baseUrl = environmentBaseUrl(config.environment);

        // 3. Credentials present
        const missing: string[] = [];
        if (!config.auth.appId) missing.push('GP_API_APP_ID');
        if (!config.auth.appKey) missing.push('GP_API_APP_KEY');

        if (missing.length > 0) {
          const gpError = new GlobalPaymentsError(
            ERROR_CODES.E_AUTH_MISSING_CREDENTIALS,
            `Missing required credential(s): ${missing.join(', ')}.`,
            { details: { missing } }
          );
          checks.push(fail('credentials', 'Credentials present', gpError.message, gpError));
          return {
            data: {
              ready: false,
              environment: config.environment,
              baseUrl,
              accountName: config.account?.accountName,
              configSource,
              configPath,
              checks,
              packsAvailable
            } satisfies DoctorData,
            error: gpError
          };
        }
        checks.push(pass('credentials', 'Credentials present', 'appId and appKey are set (values redacted).'));

        // 4. Token exchange — the only network call doctor makes.
        try {
          const token = await withSpinner(
            `Exchanging credentials for a ${config.environment} token`,
            () =>
              new GpApiAuthProvider().getToken({
                appId: config.auth.appId,
                appKey: config.auth.appKey,
                environment: config.environment,
                apiVersion: config.auth.apiVersion
              }),
            { silent: options.json }
          );
          checks.push(
            pass(
              'auth',
              'GP API token exchange',
              `Token acquired from ${baseUrl}; type=${token.metadata.tokenType ?? 'unknown'}, expiresIn=${token.metadata.expiresIn ?? 'unknown'}s.`
            )
          );
        } catch (error) {
          const gpError = toGlobalPaymentsError(error);
          checks.push(fail('auth', 'GP API token exchange', gpError.message, gpError));
          return {
            data: {
              ready: false,
              environment: config.environment,
              baseUrl,
              accountName: config.account?.accountName,
              configSource,
              configPath,
              checks,
              packsAvailable
            } satisfies DoctorData,
            error: gpError
          };
        }

        // 5. Packs
        // A missing directory is a packaging fault in this install, not a user
        // error, so it fails loudly instead of silently reporting zero suites.
        if (packsAvailable.length > 0) {
          checks.push(
            pass(
              'packs',
              'Certification suites available',
              `${packsAvailable.length} bundled suite(s): ${packsAvailable.join(', ')}.`
            )
          );
        } else if (!builtinPacksDirExists()) {
          checks.push(
            fail(
              'packs',
              'Certification suites available',
              `Bundled packs directory is missing at ${resolveBuiltinPacksDir()}.`,
              new GlobalPaymentsError(
                ERROR_CODES.E_INTERNAL,
                'The installed package is incomplete: its bundled certification suites are missing.',
                { remediation: 'Reinstall @globalpayments/cli, or run `npm run build` if working from source.' }
              )
            )
          );
        } else {
          checks.push({
            id: 'packs',
            title: 'Certification suites available',
            status: 'skip',
            detail: 'Bundled packs directory is present but empty. Supply your own via packs.directory in config.'
          });
        }

        // `ready` is derived, never asserted: it is true exactly when no check
        // failed, so the field can never disagree with the checks beneath it.
        const failed = checks.filter((check) => check.status === 'fail');

        const data: DoctorData = {
          ready: failed.length === 0,
          environment: config.environment,
          baseUrl,
          accountName: config.account?.accountName,
          configSource,
          configPath,
          checks,
          packsAvailable
        };

        if (failed.length > 0) {
          const first = failed[0]!;
          return {
            data,
            render: renderDoctor,
            error: new GlobalPaymentsError(
              (first.errorCode ?? ERROR_CODES.E_INTERNAL) as ErrorCode,
              `Readiness check failed: ${first.title}. ${first.detail}`,
              { ...(first.remediation ? { remediation: first.remediation } : {}) }
            )
          };
        }

        return {
          data,
          render: renderDoctor,
          nextActions: [
            {
              reason: 'Inspect what a suite asserts before running it.',
              command: `globalpayments cases list --cert ${packsAvailable[0] ?? '<packId>'} --json`
            },
            {
              reason: 'Evaluate transactions against a suite.',
              command: `globalpayments run --cert ${packsAvailable[0] ?? '<packId>'} --json`
            }
          ]
        };
      });
    });
}
