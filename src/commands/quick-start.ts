import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import pc from 'picocolors';
import { loadEnvFile } from '../config/env.js';
import { loadObserverConfig } from '../config/load.js';
import { runCommand } from '../contract/emit.js';
import { ERROR_CODES, GlobalPaymentsError, type ErrorCode } from '../contract/errors.js';

interface TutorialStep {
  id: string;
  title: string;
  explanation: string;
  command?: string;
}

const steps: TutorialStep[] = [
  {
    id: 'sandbox',
    title: 'Get sandbox access',
    explanation: 'Create a developer account and app at https://developer.globalpayments.com. Sandbox is a test environment, not live payments. The CLI cannot create the app for you.',
    command: 'globalpayments sandbox create'
  },
  {
    id: 'doctor',
    title: 'Check your connection',
    explanation: 'Your app ID and key authenticate to GP API. The doctor checks the token exchange, not every API permission.',
    command: 'globalpayments doctor'
  },
  {
    id: 'cases',
    title: 'Explore a certification case',
    explanation: 'A pack is a group of cases. A case matches an observed transaction or API action and checks its outcome.',
    command: 'globalpayments cases list --cert global-core'
  },
  {
    id: 'transactions',
    title: 'Read sandbox transactions',
    explanation: 'A transaction is a payment operation. This optional read queries GP API; it does not send a payment.',
    command: 'globalpayments api get /transactions?page_size=5'
  },
  {
    id: 'watch',
    title: 'Watch an integration',
    explanation: 'Send a sandbox CNP sale using your integration, then watch the global-core case. Watch reads existing activity; it never creates or captures a payment.',
    command: 'globalpayments watch --cert global-core --timeout 5m'
  },
  {
    id: 'diagnose',
    title: 'Understand the result',
    explanation: 'Pass means the latest match satisfied the case; fail means it did not; pending means no match was seen in the polling window. Diagnose explains non-passing cases after a run.',
    command: 'globalpayments diagnose'
  }
];

const exitErrors: Record<number, ErrorCode> = {
  1: ERROR_CODES.E_CERT_REQUIRED_CASES_FAILING,
  2: ERROR_CODES.E_USAGE,
  3: ERROR_CODES.E_CONFIG_INVALID,
  4: ERROR_CODES.E_AUTH_FAILED,
  5: ERROR_CODES.E_NETWORK,
  6: ERROR_CODES.E_RESULT_NOT_FOUND,
  7: ERROR_CODES.E_INTERNAL,
  8: ERROR_CODES.E_API_REJECTED,
  9: ERROR_CODES.E_WEBHOOK_DELIVERY,
  10: ERROR_CODES.E_AGENT_SETUP_FAILED
};

async function askYesNo(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  prompt.once('close', () => controller.abort());
  try {
    while (true) {
      const answer = (await prompt.question(`${question} [y/N] `, { signal: controller.signal })).trim().toLowerCase();
      if (answer === '' || answer === 'n' || answer === 'no') return false;
      if (answer === 'y' || answer === 'yes') return true;
      process.stdout.write('Please enter y or n.\n');
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, 'Quick-start was interrupted.', {
      remediation: 'Run quick-start again in an interactive terminal.'
    });
  } finally {
    prompt.close();
  }
}

async function runChild(args: string[]): Promise<number> {
  const entry = process.argv[1];
  if (!entry) throw new GlobalPaymentsError(ERROR_CODES.E_INTERNAL, 'Cannot locate the CLI entry point.');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, entry, ...args], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === null) {
        reject(new GlobalPaymentsError(ERROR_CODES.E_USAGE, `Tutorial step interrupted${signal ? ` (${signal})` : ''}.`));
      } else {
        resolve(code);
      }
    });
  });
}

async function requireSandbox(): Promise<void> {
  loadEnvFile('.env');
  const config = await loadObserverConfig();
  if (config.environment !== 'sandbox') {
    throw new GlobalPaymentsError(ERROR_CODES.E_CONFIG_INVALID, 'Quick-start network steps require the resolved environment to be sandbox.', {
      remediation: 'Use sandbox credentials and ensure the resolved configuration environment is sandbox.'
    });
  }
}

export interface TutorialDependencies {
  say: (text: string) => void;
  confirm: (question: string) => Promise<boolean>;
  run: (args: string[]) => Promise<number>;
  checkSandbox: () => Promise<void>;
}

export async function runTutorial(deps: TutorialDependencies): Promise<number> {
  const { say, confirm, run, checkSandbox } = deps;
  let watchExit = 0;
  async function execute(args: string[], sandbox: boolean): Promise<number> {
    if (sandbox) await checkSandbox();
    const exit = await run(args);
    if (exit !== 0 && !(args[0] === 'watch' && exit === 1)) {
      throw new GlobalPaymentsError(exitErrors[exit] ?? ERROR_CODES.E_INTERNAL, `Tutorial step "${args.join(' ')}" exited with code ${exit}.`, {
        remediation: 'Review the step output above, correct the issue, and rerun quick-start.'
      });
    }
    return exit;
  }

  say(pc.blue('  ____ _       _           _   ____                                   _       '));
  say(pc.blue(' / ___| | ___ | |__   __ _| | |  _ \\ __ _ _   _ _ __ ___   ___ _ __ | |_ ___ '));
  say(pc.blue('| |  _| |/ _ \\| \'_ \\ / _` | | | |_) / _` | | | | \'_ ` _ \\ / _ \\ \'_ \\| __/ __|'));
  say(pc.blue('| |_| | | (_) | |_) | (_| | | |  __/ (_| | |_| | | | | | |  __/ | | | |_\\__ \\'));
  say(pc.blue(' \\____|_|\\___/|_.__/ \\__,_|_| |_|   \\__,_|\\__, |_| |_| |_|\\___|_| |_|\\__|___/'));
  say(pc.cyan('                                           |___/  DEVELOPER CLI'));
  say('\nWelcome! This tutorial is optional and uses sandbox only. No payments are sent automatically.\n');

  for (const [index, step] of steps.entries()) {
    say(`${index + 1}. ${step.title}\n   ${step.explanation}`);
    if (step.command) say(`   ${step.command}`);
    if (step.id === 'sandbox') {
      say('   Setup writes credentials to .env and may update .gitignore. Do not use production credentials.');
      if (await confirm('   Set up existing sandbox app credentials now?')) await execute(['sandbox', 'create'], false);
    } else if (step.id === 'doctor') {
      if (await confirm('   Check sandbox credentials and connectivity now?')) await execute(['doctor'], true);
    } else if (step.id === 'cases') {
      if (await confirm('   List the global-core case now?')) await execute(['cases', 'list', '--cert', 'global-core'], false);
    } else if (step.id === 'transactions') {
      if (await confirm('   Read up to five sandbox transactions now?')) await execute(['api', 'get', '/transactions?page_size=5'], true);
    } else if (step.id === 'watch') {
      say('   Watch polls for up to five minutes, stops when required cases pass, and writes a local result.');
      if (await confirm('   Start the sandbox observer now?')) {
        watchExit = await execute(['watch', '--cert', 'global-core', '--timeout', '5m'], true);
        if (watchExit === 1) say('   The observer finished without a passing required case. Use diagnose to inspect the saved result.');
      }
    }
    say('');
  }
  return watchExit;
}

export function registerQuickStartCommand(program: Command): void {
  program
    .command('quick-start')
    .description('Learn the CLI with a guided, sandbox-focused introduction')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { json?: boolean }) => {
      await runCommand('quick-start', { json: options.json }, async (say) => {
        if (options.json) return { data: { interactive: false, steps } };
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new GlobalPaymentsError(ERROR_CODES.E_USAGE, 'Quick-start requires an interactive terminal.', {
            remediation: 'Run it in a terminal, or use `globalpayments quick-start --json` for the tutorial steps.'
          });
        }
        const exit = await runTutorial({ say, confirm: askYesNo, run: runChild, checkSandbox: requireSandbox });
        return {
          data: { interactive: true, steps },
          ...(exit === 1 ? { error: new GlobalPaymentsError(ERROR_CODES.E_CERT_REQUIRED_CASES_FAILING, 'The observed required case is not passing.') } : {})
        };
      });
    });
}
