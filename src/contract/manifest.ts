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
  /** Literal invocation, e.g. `gpcli cases show <caseId>`. */
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
 * Environment inputs. These are the only external state gpcli reads besides the
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
    'gpcli never creates transactions. It polls the GP API for transactions you have already generated and judges them against certification cases. If nothing is passing, the usual cause is that no matching transaction has been sent yet.',
  pack: 'A named, versioned collection of certification cases. Packs may extend other packs; child cases override parent cases with the same local id.',
  case: 'One certification assertion: a matcher that selects transactions, plus an expectation those transactions must satisfy.',
  caseAddress: `A case's globally unique id, formed as <packId>${ID_SEPARATOR}<caseId>. This is the id used in every result, every state entry, and every command that accepts a case.`,
  matching:
    'Cases are matched to transactions by the most specific available strategy, in order: exact-reference, reference-prefix, composite. The most recent matching transaction wins ("latest-match-wins").',
  status:
    "Per-case outcome. 'pass' = the latest match satisfied the expectation. 'fail' = a match was found but violated it. 'pending' = no matching transaction was observed at all.",
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
      { command: 'gpcli explain --json', purpose: 'Load the full interface contract.' },
      { command: 'gpcli doctor --json', purpose: 'Verify credentials and connectivity before spending time on a run.' },
      { command: 'gpcli packs list --json', purpose: 'Discover which certification suites are available.' },
      { command: 'gpcli cases list --cert <packId> --json', purpose: 'See exactly what the suite will assert.' },
      { command: 'gpcli run --cert <packId> --json', purpose: 'Evaluate and persist a result.' }
    ]
  },
  {
    id: 'diagnose-failure',
    goal: 'Understand why a case is not passing.',
    steps: [
      { command: 'gpcli report --json', purpose: 'Read the last persisted result and its per-case reasons.' },
      { command: 'gpcli cases show <packId>:<caseId> --json', purpose: 'Read the matcher and expectation the case enforces.' },
      { command: 'gpcli run --cert <packId> --timeout 30s --json', purpose: 'Re-evaluate after sending a corrected transaction.' }
    ]
  },
  {
    id: 'ci',
    goal: 'Gate a pipeline on certification status.',
    steps: [
      { command: 'gpcli run --cert <packId> --json', purpose: 'Exit 0 when all required cases pass, 1 when they do not.' }
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
 * `gpcli explain` automatically, so the manifest cannot fall out of date.
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
      usage: ['gpcli', ...path, ...args.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`))].join(' '),
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
    tool: 'gpcli',
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
      { path: '.gpcli/results/latest.json', description: 'The most recent run result. Read by `gpcli report`.' },
      { path: '.gpcli/results/history/<timestamp>.json', description: 'Immutable per-run archive.' }
    ],
    workflows: WORKFLOWS
  };
}
