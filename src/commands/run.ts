import { Command } from 'commander';
import pc from 'picocolors';
import { ConfigLoadError, loadObserverConfig } from '../config/load.js';
import { loadEnvFile } from '../config/env.js';
import { loadPackGraph } from '../core/pack-loader.js';
import { resolveActivePacks, resolveInheritedPack } from '../core/pack-resolver.js';
import {
  AuthFailureError,
  GpApiAuthProvider,
  InvalidCredentialsError,
  MalformedAuthResponseError,
  NetworkAuthError,
  environmentBaseUrl
} from '../gpapi/auth.js';
import { HttpGpApiClient } from '../gpapi/client.js';
import { CertificationEngine } from '../core/engine.js';
import { loadEvaluators, loadPackEvaluators } from '../core/evaluator.js';
import { persistRunResult } from '../core/result-store.js';
import { redactObject } from '../core/redaction.js';
import { enrichCasesWithDiagnostics } from '../core/diagnostics.js';
import { parseDuration, formatDuration } from '../util/index.js';
import type { RunResult, CaseEvaluationResult } from '../types/domain.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run certification evaluation in CI-friendly mode')
    .option('--config <path>', 'Config path (optional; can use env vars only)')
    .option('--env-file <path>', 'Env file path', '.env')
    .option('--timeout <duration>', 'Timeout duration', '5m')
    .option('--pack <packId...>', 'Activate additional pack(s)')
    .option('--profile <name>', 'Activate profile-defined packs')
    .option('--cert <name>', 'Activate a bundled certification suite by name (e.g. global-core, us-retail)')
    .option('--json', 'Output result as JSON')
    .action(async (options: { config?: string; envFile: string; timeout: string; pack?: string[]; profile?: string; cert?: string; json?: boolean }) => {
      try {
        loadEnvFile(options.envFile);
        const config = await loadObserverConfig(options.config);
        const timeoutMs = parseDuration(options.timeout);

        // --cert is shorthand for --pack; merge it in
        const certPacks = options.cert ? [options.cert] : [];
        const activePacks = resolveActivePacks(config, [...(options.pack ?? []), ...certPacks], options.profile);

        if (activePacks.length === 0) {
          console.log(pc.red('No packs activated. Use --pack <packId> or --profile <name>'));
          process.exitCode = 1;
          return;
        }

        if (!options.json) {
          console.log(pc.cyan('run'), `Executing certification run for ${activePacks.length} pack(s)...`);
        }

        // Load packs
        const graph = await loadPackGraph(config.packs?.directory, activePacks);
        const packs = activePacks.map((packId) => resolveInheritedPack(packId, graph));

        // Authenticate
        const authProvider = new GpApiAuthProvider();
        const client = new HttpGpApiClient({
          authProvider,
          authInput: {
            appId: config.auth.appId,
            appKey: config.auth.appKey,
            environment: config.environment,
            apiVersion: config.auth.apiVersion
          },
          accountName: config.account?.accountName
        });

        // Load evaluators
        const evaluators = await loadEvaluators(config);
        const packEvaluators = await loadPackEvaluators(config, activePacks);

        // Create engine
        const engine = new CertificationEngine(config, packs, client, evaluators, packEvaluators);
        let didTimeout = false;
        let fetchedTransactionsTotal = 0;

        engine.on('cycleComplete', (evt) => {
          fetchedTransactionsTotal += evt.transactionsFetched;
        });

        engine.on('watchTimeout', () => {
          didTimeout = true;
        });

        // Run with timeout
        await engine.watch({ maxTimeoutMs: timeoutMs });

        // Collect results
        const state = engine.getCaseStates();
        let caseResults: CaseEvaluationResult[] = state.map((cs) => ({
          namespacedCaseId: cs.namespacedId,
          packId: cs.packId,
          caseId: cs.caseId,
          status: cs.status,
          reason: cs.reason,
          latestMatch: cs.latestMatch,
          matchedCount: cs.matchedCount
        }));

        // Enrich failed cases with diagnostics (best-effort)
        try {
          caseResults = await enrichCasesWithDiagnostics(caseResults, {
            authProvider,
            authInput: {
              appId: config.auth.appId,
              appKey: config.auth.appKey,
              environment: config.environment,
              apiVersion: config.auth.apiVersion
            },
            baseUrl: environmentBaseUrl(config.environment),
            apiVersion: config.auth.apiVersion,
            fetchImpl: undefined
          });
        } catch {
          // Diagnostics enrichment is best-effort; continue without it
        }

        const passCount = caseResults.filter((c) => c.status === 'pass').length;
        const failCount = caseResults.filter((c) => c.status === 'fail').length;
        const pendCount = caseResults.filter((c) => c.status === 'pending').length;

        const result: RunResult = {
          timestamp: new Date().toISOString(),
          profile: options.profile,
          activePacks,
          summary: {
            pass: passCount,
            fail: failCount,
            pending: pendCount,
            total: caseResults.length
          },
          cases: caseResults,
          redactedConfig: redactObject(config as unknown as Record<string, unknown>)
        };

        // Persist result
        const paths = await persistRunResult(result);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log();
          console.log(pc.bold('Summary:'));
          console.log(`  ${pc.green(`${passCount} pass`)}, ${pc.red(`${failCount} fail`)}, ${pc.gray(`${pendCount} pending`)}`);
          console.log(`  Total: ${caseResults.length} case(s)`);
          if (fetchedTransactionsTotal === 0) {
            console.log(`  ${pc.yellow('No transactions found in polling window(s)')}`);
          }
          if (didTimeout) {
            console.log(`  ${pc.yellow('Timeout reached, reporting partial results')}`);
          }
          console.log();
          console.log('Result saved:', pc.cyan(paths.latestPath));
        }

        // Set exit code based on failures
        const requiredCases = caseResults.filter((c) => {
          const packId = c.packId;
          const pack = packs.find((p) => p.id === packId);
          if (!pack) return false;
          const packCase = pack.cases.find((pc) => pc.id === c.caseId);
          return packCase && packCase.required;
        });

        const requiredPassing = requiredCases.filter((c) => c.status === 'pass').length;
        if (requiredPassing < requiredCases.length) {
          if (!options.json) {
            console.log();
            console.log(pc.red(`✗ ${requiredCases.length - requiredPassing} required case(s) not passing`));
          }
          process.exitCode = 1;
        } else if (failCount > 0) {
          if (!options.json) {
            console.log();
            console.log(pc.yellow(`⚠ ${failCount} optional case(s) failed`));
          }
          process.exitCode = 0; // Don't fail on optional cases
        } else if (!options.json) {
          console.log(pc.green('✓ All required cases passing'));
        }
      } catch (error) {
        if (error instanceof ConfigLoadError) {
          console.error(pc.red('run failed:'), error.message);
          process.exitCode = 1;
          return;
        }
        if (error instanceof InvalidCredentialsError) {
          console.error(pc.red('run failed:'), 'invalid credentials for GP API authentication');
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        if (error instanceof NetworkAuthError) {
          console.error(pc.red('run failed:'), 'network error while authenticating with GP API');
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        if (error instanceof MalformedAuthResponseError || error instanceof AuthFailureError) {
          console.error(pc.red('run failed:'), error.message);
          process.exitCode = 1;
          return;
        }

        const msg = error instanceof Error ? error.message : String(error);
        console.error(pc.red('run failed:'), msg);
        process.exitCode = 1;
      }
    });
}
