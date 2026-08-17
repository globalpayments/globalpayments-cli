import { Command } from 'commander';
import pc from 'picocolors';
import { clearScreenDown } from 'node:readline';
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
import type { CaseRunState } from '../core/engine.js';
import { loadEvaluators, loadPackEvaluators } from '../core/evaluator.js';
import { persistRunResult } from '../core/result-store.js';
import { redactObject } from '../core/redaction.js';
import { enrichCasesWithDiagnostics } from '../core/diagnostics.js';
import { parseDuration, formatDuration } from '../util/index.js';
import type { RunResult, CaseEvaluationResult, ObservedTxn } from '../types/domain.js';

function renderCaseState(state: CaseRunState): string {
  const icon = state.status === 'pass' ? pc.green('✓') : state.status === 'fail' ? pc.red('✗') : pc.gray('○');
  const status = state.status === 'pass' ? pc.green('PASS') : state.status === 'fail' ? pc.red('FAIL') : pc.gray('PEND');
  const reason = state.status !== 'pass' ? pc.gray(` — ${state.reason}`) : '';
  return `  ${icon} ${state.namespacedId} [${status}]${reason}`;
}

function renderRecentTransaction(txn: ObservedTxn): string {
  const time = txn.timeCreated ? new Date(txn.timeCreated).toLocaleTimeString() : '?';
  const amount = txn.amount !== undefined ? `${txn.amount} ${txn.currency ?? ''}`.trim() : '';
  const card = txn.cardBrand ? `${txn.cardBrand}${txn.last4 ? ` ····${txn.last4}` : ''}` : '';
  const parts = [
    pc.gray(time),
    txn.type ? pc.cyan(txn.type) : '',
    txn.status ? pc.white(txn.status) : '',
    amount ? pc.yellow(amount) : '',
    card ? pc.gray(card) : '',
    txn.responseCode ? pc.gray(`[${txn.responseCode}]`) : ''
  ].filter(Boolean);
  return `  ${parts.join('  ')}`;
}

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Watch for certification case state changes over time')
    .option('--config <path>', 'Config path (optional; can use env vars only)')
    .option('--env-file <path>', 'Env file path', '.env')
    .option('--timeout <duration>', 'Timeout duration', '10m')
    .option('--pack <packId...>', 'Activate additional pack(s)')
    .option('--profile <name>', 'Activate profile-defined packs')
    .option('--cert <name>', 'Activate a bundled certification suite by name (e.g. global-core, us-retail)')
    .action(async (options: { config?: string; envFile: string; timeout: string; pack?: string[]; profile?: string; cert?: string }) => {
      try {
        loadEnvFile(options.envFile);
        const config = await loadObserverConfig(options.config);
        const timeoutMs = parseDuration(options.timeout);

        // --cert is shorthand for --pack; merge it in
        const certPacks = options.cert ? [options.cert] : [];
        const activePacks = resolveActivePacks(config, [...(options.pack ?? []), ...certPacks], options.profile);

        if (activePacks.length === 0) {
          console.log(pc.yellow('No packs activated. Use --pack <packId> or --profile <name>'));
          process.exitCode = 1;
          return;
        }

        console.log(pc.cyan('watch'), `Starting certification watch for ${activePacks.length} pack(s)...\n`);

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

        let observedAnyTransactions = false;
        let didTimeout = false;
        let timeoutElapsedMs = 0;

        engine.on('cycleComplete', (result) => {
          const state = engine.getCaseStates();
          if (result.transactionsFetched > 0) {
            observedAnyTransactions = true;
          }

          let passCount = 0,
            failCount = 0,
            pendCount = 0;

          const lines: string[] = [];
          lines.push(`${pc.gray(`[Cycle ${result.cycleNumber}]`)} ${result.transactionsFetched} transaction(s) fetched`);
          if (result.transactionsFetched === 0) {
            lines.push(pc.yellow('  No transactions found in this polling window.'));
          }
          lines.push('');

          for (const cs of state) {
            lines.push(renderCaseState(cs));
            if (cs.status === 'pass') passCount++;
            else if (cs.status === 'fail') failCount++;
            else pendCount++;
          }

          lines.push('');
          lines.push(
            `Summary: ${pc.green(`${passCount} pass`)}, ${pc.red(`${failCount} fail`)}, ${pc.gray(`${pendCount} pending`)}`
          );

          if (result.recentTransactions && result.recentTransactions.length > 0) {
            lines.push('');
            lines.push(pc.gray('Recent transactions:'));
            for (const txn of result.recentTransactions) {
              lines.push(renderRecentTransaction(txn));
            }
          }

          const frame = `${lines.join('\n')}\n`;

          if (process.stdout.isTTY) {
            process.stdout.write('\x1B[H');
            clearScreenDown(process.stdout);
          }

          process.stdout.write(frame);
        });

        engine.on('watchTimeout', (evt) => {
          didTimeout = true;
          timeoutElapsedMs = evt.elapsedMs;
          console.log();
          console.log(pc.yellow('✗ Timeout after'), formatDuration(evt.elapsedMs));
          const state = engine.getCaseStates();
          const required = state.filter((s) => {
            const packId = s.packId;
            const caze = packs.find((p) => p.id === packId)?.cases.find((c) => c.id === s.caseId);
            return caze && caze.required;
          });
          const passing = required.filter((s) => s.status === 'pass').length;
          console.log(pc.gray(`Required cases: ${passing}/${required.length} passing`));
          console.log(pc.gray('Partial results will be saved.'));
        });

        engine.on('allRequiredCasesPassing', (evt) => {
          console.log();
          console.log(pc.green('✓ All required cases passing after'), formatDuration(evt.elapsedMs));
        });

        engine.on('error', (evt) => {
          console.error(pc.red('Error:'), evt.message);
        });

        // Run watch with timeout
        await engine.watch({ maxTimeoutMs: timeoutMs });

        // Collect and persist results
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
        console.log();
        if (!observedAnyTransactions) {
          console.log(pc.yellow('No transactions were observed during this watch run.'));
        }
        if (didTimeout) {
          console.log(pc.yellow(`Watch ended due to timeout (${formatDuration(timeoutElapsedMs)}).`));
          console.log(pc.gray('Saved result contains partial evaluation state.'));
        }
        console.log('Result saved:', pc.cyan(paths.latestPath));
      } catch (error) {
        if (error instanceof ConfigLoadError) {
          console.error(pc.red('watch failed:'), error.message);
          process.exitCode = 1;
          return;
        }
        if (error instanceof InvalidCredentialsError) {
          console.error(pc.red('watch failed:'), 'invalid credentials for GP API authentication');
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        if (error instanceof NetworkAuthError) {
          console.error(pc.red('watch failed:'), 'network error while authenticating with GP API');
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        if (error instanceof MalformedAuthResponseError || error instanceof AuthFailureError) {
          console.error(pc.red('watch failed:'), error.message);
          process.exitCode = 1;
          return;
        }

        const msg = error instanceof Error ? error.message : String(error);
        console.error(pc.red('watch failed:'), msg);
        process.exitCode = 1;
      }
    });
}
