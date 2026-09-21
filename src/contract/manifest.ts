import type { Command } from 'commander';
import {
  EXIT_CODES,
  EXIT_CODE_DESCRIPTIONS,
  RETRYABLE_EXIT_CODES,
  type ExitCodeName
} from './exit-codes.js';
import { ERROR_CODES, ERROR_CODE_EXIT, ERROR_CODE_REMEDIATION, type ErrorCode } from './errors.js';
import { CLI_VERSION, ENVELOPE_SCHEMA_VERSION, RESULT_SCHEMA_VERSION } from './version.js';
import { ID_SEPARATOR } from '../core/ids.js';

export interface ManifestOption {
  flags: string;
  description: string;
  defaultValue?: unknown;
  required: boolean;
  takesValue: boolean;
  variadic: boolean;
}

export interface ManifestCommand {
  /** Dotted id, matching `envelope.command` exactly. */
  id: string;
  /** Literal invocation, e.g. `globalpayments cases show <caseId>`. */
  usage: string;
  description: string;
  arguments: Array<{ name: string; required: boolean; description: string }>;
  options: ManifestOption[];
  supportsJson: boolean;
}

export interface EnvVar {
  name: string;
  required: boolean;
  description: string;
  default?: string;
}

/**
 * Environment inputs. These are the only external state globalpayments reads besides the
 * optional config file.
 */
export const ENVIRONMENT_VARIABLES: EnvVar[] = [
  {
    name: 'GP_API_APP_ID',
    required: true,
    description: 'GP API application ID used for the token handshake.'
  },
  {
    name: 'GP_API_APP_KEY',
    required: true,
    description: 'GP API application key. Never printed; redacted from all output and artifacts.'
  },
  {
    name: 'GP_ENVIRONMENT',
    required: false,
    default: 'sandbox',
    description: "Target GP environment: 'sandbox' or 'production'."
  },
  {
    name: 'GP_API_VERSION',
    required: false,
    default: '2021-03-22',
    description: 'GP API version header sent with every request.'
  },
  {
    name: 'GP_ACCOUNT_NAME',
    required: false,
    description: 'Restricts transaction polling and matching to a single GP account.'
  }
];

/**
 * The conceptual model, stated once, in machine-readable form.
 *
 * An automated caller that reads this does not need to infer the domain from prose
 * documentation or from the shape of the output.
 */
export const CONCEPTS: Record<string, string> = {
  observer:
    'globalpayments never creates transactions. It polls the GP API for transactions you have already generated and judges them against certification cases. If nothing is passing, the usual cause is that no matching transaction has been sent yet.',
  pack: 'A named, versioned collection of certification cases. Packs may extend other packs; child cases override parent cases with the same local id.',
  case: 'One certification assertion: a matcher that selects transactions, plus an expectation those transactions must satisfy.',
  caseAddress: `A case's globally unique id, formed as <packId>${ID_SEPARATOR}<caseId>. This is the id used in every result, every state entry, and every command that accepts a case.`,
  matching:
    'Cases are matched to transactions by the most specific available strategy, in order: exact-reference, reference-prefix, composite. The most recent matching transaction wins ("latest-match-wins").',
  status:
    "Per-case outcome. 'pass' = the latest match satisfied the expectation. 'fail' = a match was found but violated it. 'pending' = no matching transaction was observed at all.",
  diagnosis:
    "Attached to every non-passing case as `cases[].diagnosis`. Explains the failure at field level and states what to change in the request. `code` is the stable cause category; `nearMisses[].mismatchedFields` names the exact matcher fields that differed and their expected vs observed values; `fixes` is an ordered list of corrective actions, each with `field`, `currentValue`, and `requiredValue` so it can be applied without parsing prose; `requiredRequest` is the canonical request that satisfies the case. Read it with `globalpayments diagnose`.",
  fixPlan:
    'The flattened, ordered list of every fix across every non-passing case, emitted by `globalpayments diagnose` as `data.fixPlan`. Apply it top to bottom: entries are sorted most-specific-first, so a concrete field change always precedes generic advice.',
  verdict:
    "Whole-run outcome. 'passed' only when every required case is passing. Optional case failures do not change the verdict or the exit code.",
  window:
    'Each poll cycle queries a bounded time window derived from polling.lookbackMinutes and polling.overlapSeconds. Transactions older than the window are invisible to the run.'
};

export interface Workflow {
  id: string;
  goal: string;
  steps: Array<{ command: string; purpose: string }>;
}

/**
 * Canonical task recipes.
 *
 * These exist so a caller can accomplish a goal without search: the sequence of
 * commands for each common objective is stated explicitly.
 */
export const WORKFLOWS: Workflow[] = [
  {
    id: 'first-run',
    goal: 'Go from an unconfigured checkout to a certification result.',
    steps: [
      { command: 'globalpayments explain --json', purpose: 'Load the full interface contract.' },
      { command: 'globalpayments doctor --json', purpose: 'Verify credentials and connectivity before spending time on a run.' },
      { command: 'globalpayments packs list --json', purpose: 'Discover which certification suites are available.' },
      { command: 'globalpayments cases list --cert <packId> --json', purpose: 'See exactly what the suite will assert.' },
      { command: 'globalpayments run --cert <packId> --json', purpose: 'Evaluate and persist a result.' }
    ]
  },
  {
    id: 'diagnose-failure',
    goal: 'Understand why a case is not passing and what to change to make it pass.',
    steps: [
      {
        command: 'globalpayments diagnose --json',
        purpose:
          'Field-level cause plus an ordered fix plan for every non-passing case. Offline: reads the last run result, no credentials needed.'
      },
      {
        command: 'globalpayments diagnose <packId>:<caseId> --json',
        purpose: 'Narrow to one case: its near misses, per-field deltas, and the exact request that satisfies it.'
      },
      { command: 'globalpayments cases show <packId>:<caseId> --json', purpose: 'Read the raw matcher and expectation the case enforces.' },
      { command: 'globalpayments run --cert <packId> --timeout 30s --json', purpose: 'Re-evaluate after sending a corrected transaction.' }
    ]
  },
  {
    id: 'red-to-green',
    goal: 'Turn a failing required case green.',
    steps: [
      { command: 'globalpayments run --cert <packId> --json', purpose: 'Produce a result. Exit 1 means required cases are not passing.' },
      {
        command: 'globalpayments diagnose --json',
        purpose:
          'Read `data.fixPlan`. Each entry names the field to change, its current value, and its required value. Apply `fixPlan[0]` to the request your own integration sends, then send that transaction — globalpayments never creates one.'
      },
      {
        command: 'globalpayments diagnose <packId>:<caseId> --json',
        purpose: 'Confirm you read the right constraint before re-sending: `data.cases[0].diagnosis.requiredRequest` is the exact request shape.'
      },
      { command: 'globalpayments run --cert <packId> --json', purpose: 'Confirm the case flipped to pass. Repeat until exit 0.' }
    ]
  },
  {
    id: 'ci',
    goal: 'Gate a pipeline on certification status.',
    steps: [
      { command: 'globalpayments run --cert <packId> --json', purpose: 'Exit 0 when all required cases pass, 1 when they do not.' }
    ]
  }
];

function describeOption(option: {
  flags: string;
  description: string;
  defaultValue?: unknown;
  required?: boolean;
  optional?: boolean;
  variadic?: boolean;
}): ManifestOption {
  return {
    flags: option.flags,
    description: option.description,
    required: Boolean(option.required),
    takesValue: Boolean(option.required || option.optional),
    variadic: Boolean(option.variadic),
    ...(option.defaultValue !== undefined ? { defaultValue: option.defaultValue } : {})
  };
}

/**
 * Walk the live commander tree to describe every command.
 *
 * Derivation rather than duplication: a command added to `buildCli` appears in
 * `globalpayments explain` automatically, so the manifest cannot fall out of date.
 */
function describeCommands(program: Command, prefix: string[] = []): ManifestCommand[] {
  const out: ManifestCommand[] = [];

  for (const command of program.commands) {
    const path = [...prefix, command.name()];
    const children = describeCommands(command, path);

    // A command with subcommands is a namespace, not an invocable leaf.
    if (children.length > 0) {
      out.push(...children);
      continue;
    }

    const args = command.registeredArguments ?? [];
    const options = command.options.map(describeOption);

    out.push({
      id: path.join('.'),
      usage: ['globalpayments', ...path, ...args.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`))].join(' '),
      description: command.description(),
      arguments: args.map((a) => ({
        name: a.name(),
        required: a.required,
        description: a.description ?? ''
      })),
      options,
      supportsJson: options.some((o) => o.flags.includes('--json'))
    });
  }

  return out;
}

export interface Manifest {
  tool: string;
  cliVersion: string;
  envelopeSchemaVersion: number;
  resultSchemaVersion: number;
  description: string;
  concepts: Record<string, string>;
  identifiers: Record<string, string>;
  outputContract: Record<string, string>;
  commands: ManifestCommand[];
  exitCodes: Array<{ code: number; name: string; retryable: boolean; description: string }>;
  errorCodes: Array<{ code: ErrorCode; exitCode: number; remediation: string }>;
  environment: EnvVar[];
  artifacts: Array<{ path: string; description: string }>;
  workflows: Workflow[];
}

/** Build the complete machine-readable self-description of the CLI. */
export function buildManifest(program: Command): Manifest {
  return {
    tool: 'globalpayments',
    cliVersion: CLI_VERSION,
    envelopeSchemaVersion: ENVELOPE_SCHEMA_VERSION,
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    description:
      'Observer-only certification CLI for Global Payments. Polls the GP API for transactions, matches them to certification cases, and reports latest-match-wins results.',
    concepts: CONCEPTS,
    identifiers: {
      caseAddress: `<packId>${ID_SEPARATOR}<caseId>`,
      separator: ID_SEPARATOR,
      note: 'Case addresses are stable across cases list, cases show, run, watch, and report. The same string identifies the same case everywhere.'
    },
    outputContract: {
      envelope:
        'Every command invoked with --json writes exactly one JSON object to stdout and nothing else.',
      invariant: 'ok === (exitCode === 0), without exception, on every command.',
      failure: 'On failure, envelope.error carries a stable `code`, a human `message`, and an actionable `remediation`.',
      nextActions: 'envelope.nextActions lists literal commands to run next. Prefer them over inferring a next step.',
      branching: 'Branch on envelope.error.code or the process exit code. Never parse envelope.error.message.'
    },
    commands: describeCommands(program),
    exitCodes: (Object.keys(EXIT_CODES) as ExitCodeName[]).map((name) => ({
      code: EXIT_CODES[name],
      name,
      retryable: RETRYABLE_EXIT_CODES.includes(EXIT_CODES[name]),
      description: EXIT_CODE_DESCRIPTIONS[name]
    })),
    errorCodes: (Object.keys(ERROR_CODES) as ErrorCode[]).map((code) => ({
      code,
      exitCode: ERROR_CODE_EXIT[code],
      remediation: ERROR_CODE_REMEDIATION[code]
    })),
    environment: ENVIRONMENT_VARIABLES,
    artifacts: [
      { path: '.globalpayments/results/latest.json', description: 'The most recent run result. Read by `globalpayments report`.' },
      { path: '.globalpayments/results/history/<timestamp>.json', description: 'Immutable per-run archive.' }
    ],
    workflows: WORKFLOWS
  };
}
