import { Command } from 'commander';
import pc from 'picocolors';
import { runCommand, type CommandOutcome } from '../contract/emit.js';
import { certificationError, collectRunResult, createSession, trackObservation } from '../core/session.js';
import { persistRunResult } from '../core/result-store.js';
import { parseDuration, formatDuration } from '../util/index.js';
import { InteractiveWatchController } from '../io/interactive-watch.js';
import { renderClassicWatchFrame } from '../io/watch-renderer.js';
import { renderRunSummary, buildRunNextActions } from '../io/run-renderer.js';
import type { RunCommandData } from './run.js';

export function registerWatchCommand(program: Command): void {
  program
    .command('watch')
    .description('Poll continuously and report certification state changes until all required cases pass')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--timeout <duration>', 'Give up after this long, e.g. 30s, 5m, 1h', '10m')
    .option('--pack <packId...>', 'Activate one or more packs by id')
    .option('--profile <name>', 'Activate the packs defined by a config profile')
    .option('--cert <name>', 'Shorthand for --pack with a single bundled suite id')
    .option('--no-interactive', 'Disable keyboard navigation and the split-pane UI')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else (implies --no-interactive)')
    .action(async (options: {
      config?: string;
      envFile: string;
      timeout: string;
      pack?: string[];
      profile?: string;
      cert?: string;
      interactive?: boolean;
      json?: boolean;
    }) => {
      await runCommand<RunCommandData>('watch', { json: options.json }, async () => {
        const timeoutMs = parseDuration(options.timeout);

        const session = await createSession({
          configPath: options.config,
          envFile: options.envFile,
          packs: options.pack,
          profile: options.profile,
          cert: options.cert
        });

        // JSON mode must keep stdout clean, so live rendering is suppressed entirely.
        const interactive =
          !options.json && options.interactive !== false && process.stdin.isTTY && process.stdout.isTTY;
        const live = !options.json;

        if (live) {
          console.log(pc.cyan('watch'), `Observing ${session.activePacks.length} pack(s). Ctrl-C to stop.\n`);
        }

        const abortController = new AbortController();
        const controller = interactive
          ? new InteractiveWatchController({
              stdin: process.stdin,
              stdout: process.stdout,
              caseDefinitions: session.caseIndex,
              abortController
            })
          : undefined;

        let transactionsObserved = 0;
        let pollCycles = 0;
        let timedOut = false;
        const startedAt = Date.now();
        const observation = trackObservation(session.engine);

        session.engine.on('cycleComplete', (event) => {
          pollCycles += 1;
          transactionsObserved += event.transactionsFetched;

          if (!live) {
            return;
          }

          const cases = session.engine.getCaseStates();
          if (controller) {
            controller.update({
              cycleNumber: event.cycleNumber,
              transactionsFetched: event.transactionsFetched,
              cases,
              recentTransactions: event.recentTransactions
            });
            return;
          }

          process.stdout.write(
            renderClassicWatchFrame({
              cycleNumber: event.cycleNumber,
              transactionsFetched: event.transactionsFetched,
              cases,
              recentTransactions: event.recentTransactions,
              caseDefinitions: session.caseIndex
            })
          );
        });

        session.engine.on('watchTimeout', () => {
          timedOut = true;
        });

        session.engine.on('pollError', (event: { message: string }) => {
          if (live && !controller) {
            console.error(pc.red('poll error:'), event.message);
          }
        });
        controller?.start(session.engine.getCaseStates());
        try {
          await session.engine.watch({ maxTimeoutMs: timeoutMs, signal: abortController.signal });
        } finally {
          controller?.stop();
        }

        const result = await collectRunResult(session, { profile: options.profile });
        const paths = await persistRunResult(result);

        const data: RunCommandData = {
          ...result,
          observation: {
            pollCycles,
            transactionsObserved,
            timedOut,
            elapsedMs: Date.now() - startedAt,
            observationFailed: observation.failed
          },
          artifacts: { latest: paths.latestPath, history: paths.historyPath }
        };

        const outcome: CommandOutcome<RunCommandData> = {
          data,
          nextActions: buildRunNextActions(data),
          render: (value) => renderRunSummary(value, console.log)
        };

        const certError = observation.observationError() ?? certificationError(result);
        if (certError) {
          outcome.error = certError;
        }

        return outcome;
      });
    });
}
