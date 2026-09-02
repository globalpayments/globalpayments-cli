# AGENTS.md

Operating guide for automated agents working **on** or **with** `globalpayments`.

Humans: see [README.md](README.md). This file is the contract, stated once.

---

## 1. What this tool is

`globalpayments` is an **observer**. It never creates transactions.

It polls the Global Payments API for transactions *you have already sent*, matches
them against certification cases, and reports whether each case is satisfied.

The single most common misdiagnosis is treating a `pending` case as a bug. It is not.
`pending` means *no matching transaction was observed*. The fix is almost always to
send the transaction the case describes — not to change the tool.

---

## 2. The one command to run first

```bash
globalpayments explain --json
```

This returns the complete interface contract in one call: every command and flag,
every exit code, every error code with its remediation, every environment variable,
the domain concepts, and canonical workflows.

It is generated from the live command tree, so it cannot drift from the implementation.
Prefer it over this document when the two disagree.

---

## 3. The output contract

Every command accepts `--json`. There are no human-only commands.

With `--json`, stdout contains **exactly one JSON object and nothing else**. Progress
output, colour, and interactive UI are all suppressed. stdout is safe to pipe directly
into a parser.

```jsonc
{
  "schemaVersion": 1,
  "ok": true,
  "command": "run",              // dotted id, matches `explain` command ids
  "cliVersion": "0.1.0",
  "timestamp": "2026-09-02T12:59:16.479Z",
  "exitCode": 0,
  "data": { /* command-specific payload */ },
  "error": {                     // present only on failure
    "code": "E_AUTH_INVALID_CREDENTIALS",
    "message": "…",              // human prose; DO NOT branch on this
    "remediation": "…",          // concrete corrective action
    "exitCode": 4,
    "details": { }               // structured context, often including valid alternatives
  },
  "warnings": [ { "code": "W_…", "message": "…" } ],
  "nextActions": [ { "reason": "…", "command": "globalpayments … --json" } ]
}
```

### Invariants you can rely on

| Invariant | Meaning |
|---|---|
| `ok === (exitCode === 0)` | Holds on every command, without exception. Checking the process exit code and checking `ok` can never disagree. |
| One JSON document | In `--json` mode stdout is a single object. Nothing else is ever written there. |
| stderr is empty in `--json` mode | Failures are reported *inside* the envelope, not alongside it. |
| `error.code` is stable | Messages change freely between releases. Codes do not. |
| `nextActions` are literal | Every `command` string is runnable as-is. |
| Discovery needs no credentials | `explain`, `packs list`, `cases list`, and `cases show` resolve fully offline. You can learn the entire surface before any secret is configured. |
| Usage errors are exit 2 | An unknown flag or missing argument never collides with exit 1, so a typo can never be mistaken for a certification failure. |

**Branch on `error.code` or the exit code. Never parse `error.message`.**

---

## 4. Exit codes

| Code | Name | Meaning | Retry? |
|---|---|---|---|
| 0 | `OK` | Success. | — |
| 1 | `CERT_FAILED` | The run completed; required cases are not passing. **A result, not a tool error.** | After sending transactions |
| 2 | `USAGE` | Malformed invocation. | No — fix the arguments |
| 3 | `CONFIG` | Config missing, unparseable, or invalid. | No |
| 4 | `AUTH` | Credentials missing or rejected. | No |
| 5 | `NETWORK` | GP API unreachable. | **Yes** |
| 6 | `NOT_FOUND` | Unknown pack, case, or result artifact. | No |
| 7 | `INTERNAL` | Bug in `globalpayments`. | No — report it |

Exit `1` is the one to think carefully about: the tool worked perfectly and is telling
you the merchant is not yet certified. Do not treat it as a failure of the tool.

---

## 5. Identity: case addresses

A case has two identities. Conflating them caused a real defect (`pack:pack:case`) that
made catalog output and result output impossible to correlate.

- **local id** — `basic-sale-approved`. The case's own name, unique within its pack.
  Lives in the YAML `id:` field. Never rewritten.
- **address** — `global-core:basic-sale-approved`. Globally unique, valid only in the
  context of a pack. **Derived, never stored.**

`src/core/ids.ts` is the *only* place in the codebase that joins a pack id to a case id.
If you need an address, call `caseAddress(packId, caseId)`. It is idempotent.

The same address string identifies the same case in `cases list`, `cases show`, `run`,
`watch`, and `report`. That correlation is a guarantee — do not break it.

---

## 6. Canonical workflows

### Cold start

```bash
globalpayments explain --json                      # 1. load the contract
globalpayments doctor  --json                      # 2. verify credentials + connectivity
globalpayments packs list --json                   # 3. discover suites
globalpayments cases list --cert <packId> --json   # 4. see what will be asserted
globalpayments run --cert <packId> --json          # 5. evaluate
```

Do not skip step 2. `doctor` isolates config, credential, and network failures into
separate checks, each with its own code and remediation. Debugging those from a failed
`run` is strictly harder.

### Diagnosing a non-passing case

```bash
globalpayments report --json                                # per-case reasons
globalpayments cases show <packId>:<caseId> --json          # the matcher and expectation
```

Read `data.observation.transactionsObserved` first:

- **`0`** → nothing was in the polling window at all. Send transactions, or widen
  `polling.lookbackMinutes`. Nothing else will help.
- **`> 0` with `pending` cases** → transactions arrived but none matched the case's
  `matcher`. Compare the matcher against what you actually sent.
- **`fail` cases** → a transaction matched but violated `expect`. Read `reason`.

### CI gate

```bash
globalpayments run --cert <packId> --json    # exit 0 = certified, 1 = not
```

---

## 7. Configuration

Credentials come from the environment. **A config file is optional** — omit `--config`
entirely and `globalpayments` builds its configuration from environment variables alone.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GP_API_APP_ID` | yes | — | GP API application id |
| `GP_API_APP_KEY` | yes | — | GP API application key. Redacted from all output and artifacts. |
| `GP_ENVIRONMENT` | no | `sandbox` | `sandbox` or `production` |
| `GP_API_VERSION` | no | `2021-03-22` | GP API version header |
| `GP_ACCOUNT_NAME` | no | — | Restrict polling and matching to one account |

Passing `--config <path>` makes the path **explicit**, so a missing file becomes a hard
`E_CONFIG_READ` failure rather than falling back to environment variables. That is
deliberate: an explicit path that does not exist is a mistake worth surfacing. The same
rule governs `--env-file`: the `.env` default is tolerated when absent, any path you
name yourself is not.

Credential *presence* is never checked at config-load time — only at the moment
authentication is actually required. This is what keeps discovery commands usable
without secrets, and it means a missing credential always reports as
`E_AUTH_MISSING_CREDENTIALS` (exit 4) rather than masquerading as a config error.

Secrets are redacted by `src/core/redaction.ts` before anything is printed or persisted.
Never add a code path that writes `auth.appKey` or a bearer token.

---

## 8. Architecture

A tower of layers. Each depends only on those below it.

```
src/contract/          LAYER 1 — the boundary. Envelope, error taxonomy, exit codes,
                                 output sink, self-describing manifest.
  exit-codes.ts          the exit taxonomy
  errors.ts              GlobalPaymentsError + toGlobalPaymentsError: the ONLY error classifier
  envelope.ts            buildEnvelope: enforces ok === (exitCode === 0)
  emit.ts                emit / runCommand: the ONLY writer to stdout
  manifest.ts            buildManifest: derived from the live commander tree

src/core/ids.ts        LAYER 0 — identity. The ONLY place a case address is built.

src/types/domain.ts    LAYER 2 — the single domain vocabulary.
src/core/types.ts               matching-only types; re-exports the rest.

src/core/session.ts    LAYER 3 — one bootstrap: env → config → packs → auth →
                                 client → engine, plus result collection.

src/commands/*         LAYER 4 — thin adapters: parse options, call core, return an
                                 outcome. No try/catch. No stdout writes.

src/commands/explain   LAYER 5 — introspection.
src/commands/packs     LAYER 5 — discovery.
```

### Rules that keep the tower standing

1. **Commands never `console.log` a result and never `try/catch`.** They return a
   `CommandOutcome` or throw. `runCommand` owns rendering, classification, and exit
   codes. A command that catches its own errors silently breaks the exit-code taxonomy.
2. **Only `toGlobalPaymentsError` classifies errors.** Add new internal error types there, never
   in a command.
3. **Only `ids.ts` builds addresses.** Never write `` `${packId}:${caseId}` `` anywhere
   else.
4. **`run` and `watch` share `session.ts`.** They differ only in live rendering. If you
   change how a run is set up or collected, change it once, in the session.
5. **Nothing in `src/contract/` imports from `src/commands/`.** The contract does not
   know what commands exist; `manifest.ts` receives the program as an argument.

---

## 9. Adding a command

The manifest is derived, so a correctly registered command becomes self-describing
automatically.

```ts
export function registerThingCommand(program: Command): void {
  program
    .command('thing')
    .description('A sentence that is useful to someone who has never seen this tool')
    .option('--json', 'Emit a single JSON envelope on stdout and nothing else')
    .action(async (options: { json?: boolean }) => {
      await runCommand<ThingData>('thing', { json: options.json }, async () => {
        const data = await doTheWork();          // throw freely; the boundary classifies
        return {
          data,
          render: (value) => console.log(value), // text mode only
          nextActions: [{ reason: '…', command: 'globalpayments … --json' }]
        };
      });
    });
}
```

Then register it in `src/cli.ts`. `test/contract.test.ts` will fail if it lacks `--json`
or a real description — that is intentional.

---

## 10. Working on this repo

```bash
npm run verify    # typecheck + tests + build + build-level smoke. Use this.
npm test          # vitest, 159 tests
npm run typecheck # tsc --noEmit, strict
npm run build     # tsup → dist/, copies src/packs → dist/packs
npm run smoke     # contract checks against dist/bin.js (needs a build; no network)
npm run dev -- <args>   # run from source, e.g. npm run dev -- explain --json
```

**Finish every change with `npm run verify`.**

`npm test` alone is not sufficient. The unit suite runs in-source, so it is blind to
faults that exist only in the bundled artifact — path anchoring, packaging, stdout
purity, and commander's own exit codes. `scripts/smoke.mjs` invokes `dist/bin.js` as a
real caller would, with credentials blanked, and asserts the envelope contract end to
end. It has already caught a packs directory that resolved correctly from source and
incorrectly from `dist/`.

### Certification packs

Packs live in `src/packs/<packId>/` as `pack.yaml` plus `cases/*.yaml`, and are copied
into `dist/packs/` at build time. Packs may `extends` other packs; child cases override
parent cases with the same **local** id. Circular inheritance is detected and rejected.

Adding a pack requires no code change — it is discovered by `globalpayments packs list` on the
next build.

### Things that will bite you

- `dist/packs` is populated by `tsup`'s `onSuccess` hook. A stale `dist/` yields stale
  packs; run `npm run build` after touching `src/packs/`.
- `responseCode` is absent from the `/transactions` list endpoint. The default evaluator
  deliberately skips `responseCodeIn` when the field is missing rather than failing the
  case. Do not "fix" this into a hard failure.
- The polling window is bounded. Transactions older than
  `polling.lookbackMinutes` are invisible, no matter how long you watch.
