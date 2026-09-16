import { Command } from 'commander';
import pc from 'picocolors';
import { runCommand, type CommandOutcome } from '../contract/emit.js';
import { certificationError, collectRunResult, createSession, trackObservation } from '../core/session.js';
import { persistRunResult } from '../core/result-store.js';
import { parseDuration } from '../util/index.js';
import { renderRunSummary, buildRunNextActions } from '../io/run-renderer.js';
import type { RunResult } from '../types/domain.js';

export interface RunObservation {
  pollCycles: number;
  transactionsObserved: number;
  timedOut: boolean;
  elapsedMs: number;
  /**
   * True when no polling cycle ever read the window. Every case is then pending for
   * want of evidence rather than because it was disproved.
   */
  observationFailed?: boolean;
}

export interface RunCommandData extends RunResult {
  observation: RunObservation;
  artifacts: { latest: string; history: string };
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Evaluate certification cases once and persist a machine-readable result (CI friendly)')
    .option('--config <path>', 'Config file path. Omit to configure entirely from environment variables.')
    .option('--env-file <path>', 'Env file to load before running', '.env')
    .option('--timeout <duration>', 'Give up after this long, e.g. 30s, 5m, 1h', '5m')
    .option('--pack <packId...>', 'Activate one or more packs by id')
    .option('--profile <name>', 'Activate the packs defined by a config profile')
    .option('--cert <name>', 'Shorthand for --pack with a single bundled suite id')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: {
      config?: string;
      envFile: string;
      timeout: string;
      pack?: string[];
      profile?: string;
      cert?: string;
      json?: boolean;
    }) => {
      await runCommand<RunCommandData>('run', { json: options.json }, async () => {
        const timeoutMs = parseDuration(options.timeout);

        const session = await createSession({
          configPath: options.config,
          envFile: options.envFile,
          packs: options.pack,
          profile: options.profile,
          cert: options.cert
        });

        let transactionsObserved = 0;
        let pollCycles = 0;
        let timedOut = false;
        const startedAt = Date.now();
        const observation = trackObservation(session.engine);

        session.engine.on('cycleComplete', (event: { transactionsFetched: number }) => {
          pollCycles += 1;
          transactionsObserved += event.transactionsFetched;
        });
        session.engine.on('watchTimeout', () => {
          timedOut = true;
        });

        await session.engine.watch({ maxTimeoutMs: timeoutMs });

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

        if (observation.lastPollError) {
          outcome.warnings = [
            {
              code: 'W_POLL_FAILED',
              message: `${observation.lastPollError}. Verify with \`globalpayments doctor --json\`.`
            }
          ];
        }

        // Order matters. A run that never read the window has no certification verdict
        // to report, so the observation failure outranks the case tally.
        const certError = observation.observationError() ?? certificationError(result);
        if (certError) {
          outcome.error = certError;
        }

        return outcome;
      });
    });
}
