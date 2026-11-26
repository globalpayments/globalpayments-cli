# @globalpayments/cli

**Global Payments developer CLI. Certification runs observe transactions already sent; API writes are sandbox-only.**

Certification commands poll recent transactions and actions, match them against Global Payments certification cases, and persist results for local review and CI/CD. The CLI also supports authenticated API requests, transaction lookup, request-log tailing, local synthetic webhook testing, and AI-agent setup.

## Features

- **Certification observer** — `run` and `watch` evaluate transactions and actions already sent by your integration
- **Sandbox API access** — `api get` reads GP resources; `api post` is blocked outside sandbox
- **Transaction lookup and request logs** — Inspect one transaction or follow rejected requests in GP action history
- **Local webhook testing** — Forward webhook requests to a localhost handler and trigger signed synthetic events
- **AI-agent setup** — Install Global Payments MCP tools and SDK skills for supported coding agents
- **Latest-match-wins evaluation** — Each case re-evaluates against the newest matching transaction in the poll window
- **Certification pack system** — Modular, inheritable pack definitions with cases, matchers, and expectations
- **Safe credential handling** — Redacted config output; credentials loaded from environment or secure config
- **Sliding time-window polling** — Configurable overlap, page size, and poll interval; handles partial results gracefully
- **Declarative evaluation** — Judge the latest matching observation against the case's status and response expectations
- **Graceful failure handling** — Timeout with partial results, ambiguous-match detection, detailed error messages
- **Persistent result artifacts** — JSON output for CI consumption; timestamped history in `.globalpayments/results/`
- **CLI workflows** — Use the commands interactively or in automation
- **Machine-readable everywhere** — `--json` on every command emits one versioned envelope with stable error codes, remediation, and suggested next commands

## Interactive shell

Run `globalpayments` on its own in a terminal and you get a shell where every command is a slash command.

![The globalpayments shell: ASCII banner, sandbox badge, live command palette and completion](docs/images/shell.gif)

Type `/` to see everything, keep typing to filter, and press Enter to run the highlighted command, so `/doc` and Enter runs `/doctor`. Tab completes commands, flags and values: pack ids after `--cert`, case addresses after `cases show` and `diagnose`, webhook events after `trigger`, and matching files after `--env-file`, `--config` and `--data-file`. The up arrow goes back through history, filtered by whatever you already typed, and a grey suggestion from history can be taken with the right arrow. The badge in the prompt says whether requests go to sandbox or production, and switches the moment `/sandbox create` writes new credentials.

Every command runs exactly the way it does outside the shell, with the same flags, output and exit codes, so whatever you try here works the same in a script. Commands work with or without the slash, and a pasted `globalpayments doctor` just runs `doctor`. When something fails the shell tells you what the exit code means and which command to try next. Ctrl+C clears the line (or stops the running command), and pressing it twice on an empty line leaves.

| Shell command | What it does |
| --- | --- |
| `/help [command]` | Every command grouped by task, or the help for one |
| `/theme [name]` | Preview the colour themes, or switch to one |
| `/banner full\|compact\|off` | Choose the banner shown at start (the ASCII art, one line, or nothing) |
| `/env` | Where requests go and where the credentials came from (the key is never shown) |
| `/history` | Recent commands |
| `/docs` | Developer portal and API reference links |
| `/clear`, `/version`, `/exit` | Clear the screen, print the version, leave |

| Key | Action |
| --- | --- |
| Tab / Shift+Tab | Complete, or move through the palette |
| ↑ ↓ | Move through the palette, or through history |
| → or End | Accept the grey suggestion |
| Esc | Close the palette |
| Ctrl+A / Ctrl+E | Start or end of the line |
| Ctrl+W / Ctrl+U / Ctrl+K | Delete a word, everything before the cursor, or everything after it |
| Ctrl+L | Clear the screen |
| Ctrl+C / Ctrl+D | Clear the line / leave |

Pasting never runs half a command. A pasted newline becomes a space and nothing runs until you press Enter. History lives in your config directory and anything that looks like a card number, an inline `--data` body or a key is kept for the session only and never written to disk.

The shell only starts when both ends are a terminal. Piped, in CI, or under an agent, a bare `globalpayments` prints help and exits, and `globalpayments shell` reads commands from stdin one per line:

```bash
printf '/doctor\n/packs list\n' | globalpayments shell
```

### Make it yours

The banner at the top is plain ASCII in your terminal's own text colour, whatever the theme. Everything under it uses the Global Payments brand colours by default: the sandbox badge is white on Global Blue, accents are Pulse Blue, warnings are Creamsicle and only failures are Raspberry. A passing check is a blue tick because the brand has no green and leads positive results with blue. The `classic` theme uses your terminal's own palette if you want green and red back.

```bash
globalpayments ui themes                # preview every theme in your terminal
globalpayments ui set theme gp-light    # gp, gp-light, classic, mono, or auto
globalpayments ui set banner compact    # full, compact or off
globalpayments ui show                  # every setting and where its value came from
globalpayments ui reset                 # back to the defaults
```

| Setting | Values | Environment variable |
| --- | --- | --- |
| `theme` | `auto` (default), `gp`, `gp-light`, `classic`, `mono` | `GP_CLI_THEME` |
| `banner` | `full` (default), `compact`, `off` | `GP_CLI_BANNER` |
| `icons` | `auto` (default), `unicode`, `ascii` | `GP_CLI_ICONS` |
| `motion` | `on` (default), `off` for no animated spinners | `GP_CLI_MOTION` |
| `hints` | `on` (default), `off` for no live palette or grey suggestions | `GP_CLI_HINTS` |

Settings are personal, so they're saved in `~/.config/globalpayments/ui.json` (or `$XDG_CONFIG_HOME`, `%APPDATA%` on Windows, or `GP_CLI_CONFIG_DIR`), never in the project, and an environment variable beats the file. `auto` picks `gp-light` when the terminal says it has a light background. Colour follows the usual rules: `NO_COLOR` or `--no-color` turns it off, `FORCE_COLOR` or `--color` keeps it when piping, and output to a pipe or file never has escape codes in it. None of this changes `--json` output.

### Tab completion in your own shell

```bash
eval "$(globalpayments completion bash)"                                  # add to ~/.bashrc
eval "$(globalpayments completion zsh)"                                   # add to ~/.zshrc
globalpayments completion fish > ~/.config/fish/completions/globalpayments.fish
```

Completion asks the CLI itself on every Tab, so it knows the same commands, flags, pack ids and case addresses as the shell and never goes out of date.

## Automation and agents

Every command supports `--json`, and every JSON invocation writes exactly one envelope
to stdout and nothing else. Failures carry a stable `error.code` plus a `remediation`,
and exit codes distinguish a certification failure (`1`) from a config (`3`), auth (`4`),
or network (`5`) problem. API rejection, local webhook delivery, and agent setup have
their own exit codes (`8`–`10`).

Start here:

```bash
globalpayments explain --json    # the complete interface contract in one call
```

See **[AGENTS.md](AGENTS.md)** for the full contract, invariants, and architecture.

### Exit codes

| Code | Name | Meaning |
|---|---|---|
| 0 | `OK` | Success |
| 1 | `CERT_FAILED` | Run completed; required cases not passing (a result, not a tool error) |
| 2 | `USAGE` | Malformed invocation |
| 3 | `CONFIG` | Config missing, unparseable, or invalid |
| 4 | `AUTH` | Credentials missing or rejected |
| 5 | `NETWORK` | GP API unreachable (retryable) |
| 6 | `NOT_FOUND` | Unknown pack, case, or result artifact |
| 7 | `INTERNAL` | Bug in globalpayments |
| 8 | `API_REJECTED` | GP rejected the API request |
| 9 | `WEBHOOK_DELIVERY` | Local webhook delivery failed |
| 10 | `SETUP_FAILED` | Local MCP/skill setup failed |

Exit `1` means the window was read and the cases were judged. If polling never succeeded
at all, `run` reports the underlying cause (`4` or `5`) instead, so a credentials outage
is never mistaken for a failed certification.

## Installation

### Via npm (published package)
```bash
npm install --save-dev @globalpayments/cli
# or
npx @globalpayments/cli --help
```

The published package may not yet include all commands described on this branch.
Use `npx @globalpayments/cli <command>` for a project-local install; the bare
`globalpayments` examples below assume the executable is on your `PATH`.

### Local development
```bash
git clone https://github.com/globalpayments/globalpayments-cli.git
cd globalpayments-cli
npm install
npm run build
node dist/bin.js --help
```

### Via Docker (no Node.js/npm required)
```bash
git clone https://github.com/globalpayments/globalpayments-cli.git
cd globalpayments-cli
docker compose run --rm globalpayments --help
```
The `globalpayments` service builds a local image and runs your project directory as its working directory, so config, `.env`, and results all read/write to the same paths as running the CLI natively — swap `--help` for any other command (`init --with-config`, `doctor`, `run --cert global-core`, etc.).

## Requirements

- **Node.js** ≥ 20
- **Global Payments API credentials** (app ID + app key for an existing portal app)
- **Sandbox/production account** with transaction access

## Quick Start

For an interactive introduction to Global Payments, sandbox credentials, cases,
and observation, run:

```bash
npx @globalpayments/cli quick-start
```

In a source checkout, use `npm run quick-start` (or build and run
`node dist/bin.js quick-start`). The published npm package needs a release that
includes this command. The tutorial asks before changing local files or making
network requests; it never sends a payment. Use `quick-start --json` for its
non-interactive steps. An existing Developer Portal sandbox app is required for
connected steps.

### 1. Set up credentials
```bash
export GP_API_APP_ID="your-app-id"
export GP_API_APP_KEY="your-app-key"
export GP_API_ACCOUNT_NAME="your-account-name"  # optional; restricts matching to one account
export GP_API_ENVIRONMENT="sandbox"              # or: production
```

For interactive sandbox setup, create or select an existing sandbox app in the
[Global Payments Developer Portal](https://developer.globalpayments.com), then run
`npx @globalpayments/cli sandbox create`. It prompts for the app ID and hidden app key, saves
them to `.env`, adds an ignore rule when needed, and does not create an account or app.
This command requires a CLI version that includes the developer workflows; use the
local branch build as described below if it is not in the published package.

Or generate an optional config file:
```bash
npx @globalpayments/cli init --with-config
# Writes .env.example and globalpayments.config.yaml
# To use that file, add --config globalpayments.config.yaml to commands below.
```

The generated config does not select a certification pack. The examples below
select `global-core` explicitly; replace it with the pack you want to observe.
If you omit `--config`, the CLI can use environment variables and `.env` instead.

The `npx` examples use the installed or published package, which may not include
changes on your local branch. If you cloned this repository, run `npm run build`
and replace `npx @globalpayments/cli` with `node dist/bin.js` to use your build
(`node .\dist\bin.js` in PowerShell).

### 2. List available certification cases
```bash
npx @globalpayments/cli packs list
npx @globalpayments/cli cases list --cert global-core
```

### 3. Run certification observer
```bash
npx @globalpayments/cli doctor --json

# Watch mode: polls for up to 10 minutes, updates screen in real-time
npx @globalpayments/cli watch --cert global-core --timeout 10m

# CI mode: observe until required cases pass or the timeout is reached
npx @globalpayments/cli run --cert global-core --timeout 5m --json
```

These commands observe transactions already sent; they do not create them.
Exit `1` means the window was read but required cases are not all passing.
Other nonzero exit codes indicate an error rather than a certification verdict.

### 4. Review results
```bash
npx @globalpayments/cli report --input .globalpayments/results/latest.json
# Pretty-prints pass/fail summary with reasons
```

### 5. Turn red cases green
```bash
npx @globalpayments/cli diagnose
# For every non-passing case: which field missed, what the closest observed
# transaction looked like, and the exact change to make to your request.
```

## CLI Commands

All commands accept `--json`, which emits a single envelope on stdout and suppresses
all other output.

### `globalpayments explain`
Describe the entire CLI contract: every command and flag, every exit code, every error
code with its remediation, environment variables, domain concepts, and canonical
workflows. Generated from the live command tree, so it cannot drift from the code.

**Options:**
- `--json` — Emit the machine-readable manifest

---

### `globalpayments packs list` / `globalpayments packs show <packId>`
Discover the certification suites this build can run, with case counts, inheritance,
and metadata. `packs show` additionally lists every resolved case address.

**Options:**
- `--config <path>` — Config file path (optional)
- `--json` — Machine-readable output

---

### `globalpayments init`
Scaffold a starter `.env.example`, and optionally an annotated `globalpayments.config.yaml`.
Existing files are never overwritten.

**Options:**
- `--dir <path>` — Output directory (default: `.`)
- `--with-config` — Also write `globalpayments.config.yaml`
- `--json` — Machine-readable output

---

### `globalpayments doctor`
Structured readiness report. Runs independent checks — env file, config, credentials,
GP API token exchange, available packs — each with its own status and, on failure, a
stable error code and remediation.

**Output:**
- Per-check `status` (`pass` / `fail` / `skip`), `detail`, and `remediation`
- Resolved environment, base URL, and config source
- Available bundled certification suites
- Suggested next steps

**Options:**
- `--config <path>` — Config file (optional; omit to use env vars only)
- `--env-file <path>` — Env file to load (default: `.env`)

---

### `globalpayments auth test`
Exchange credentials for a GP API token and report safe token metadata.

**Options:**
- `--config <path>` — Config file (optional; omit to use environment variables)
- `--env-file <path>` — Env file to load (default: `.env`)

**Example:**
```bash
globalpayments auth test --json
```

---

### `globalpayments sandbox create`
Configure an existing GP Developer Portal sandbox app. Prompts for the app ID and
hidden app key, then updates only the GP credential/environment entries in `.env`.
The app key is not printed, and `.env` is added to `.gitignore` if no matching rule
already exists. This command does not create an account or portal app.
If the credentials already in the environment belong to another `GP_API_ENVIRONMENT`,
it stops instead of saving them as sandbox credentials; rerun with `--replace`.

**Options:**
- `--env-file <path>` — Env file to create or update (default: `.env`)
- `--replace` — Prompt for credentials even when already configured
- `--json` — Machine-readable output; prompts are disabled

---

### `globalpayments api get <path>` / `globalpayments api post <path>`
Make an authenticated request to a root-relative GP API path. `GET` works in the
configured environment; `POST` is rejected before sending unless the resolved
environment is `sandbox`. Requests time out after 30 seconds. If a `POST` times out
or gets a 5xx, the error has `details.mayHaveBeenProcessed: true`: check the
transaction before sending it again, because the sandbox may already have applied it.

**Options:**
- `--data <json>` or `--data-file <path>` — JSON body for `POST` (exactly one required)
- `--config <path>` — Config file path (optional)
- `--env-file <path>` — Env file to load (default: `.env`)
- `--json` — Machine-readable output

```bash
globalpayments api get /transactions --json
globalpayments api post /transactions --data-file request.json --json
```

---

### `globalpayments transactions get <id>`
Fetch one transaction by its GP transaction ID. Accepts the same `--config`,
`--env-file`, and `--json` options as `api get`.

---

### `globalpayments transactions testpay`
Initiate a real GP API sandbox TestPay sale using a public HTTPS status URL and
browser return URL you control. The URLs must point to approved infrastructure:
the CLI cannot verify that a DNS name is reachable or controlled by you.
Completing the TestPay checkout may be required before GP sends a status update;
a successful API response is not proof of notification delivery.

```bash
globalpayments transactions testpay --status-url https://YOUR-HOST/status --return-url https://YOUR-HOST/return
```

`--amount` is in minor units (default `100`); `--currency`, `--country`, and
`--account-name` default to `EUR`, `IE`, and `transaction_processing`. Their
availability depends on your sandbox account. Writes are rejected outside sandbox.
Do not use third-party webhook collectors for sensitive payloads.

---

### `globalpayments logs tail`
Poll GP `/actions` history for requests rejected with a selected HTTP status class.
Use `--once` for a snapshot or `--timeout` to bound a live tail. JSON mode requires
one of those bounds so it returns exactly one envelope. While following, a poll that
fails on the network is reported and the next poll goes ahead.

```bash
globalpayments logs tail --status 4xx
globalpayments logs tail --status 5xx --once --json
```

---

### `globalpayments listen` / `globalpayments trigger <event>`
`listen` binds only to `127.0.0.1` and forwards POSTs to an unauthenticated localhost
HTTP(S) URL. Start your local handler first, then run `listen` and `trigger` in
separate terminals. `trigger` sends a signed synthetic event to that listener; it
does not create a transaction or register a real GP webhook.

```bash
globalpayments listen --forward-to http://localhost:3000/webhooks
globalpayments trigger transaction.captured
```

Supported events: `transaction.captured`, `transaction.declined`,
`transaction.refunded`, `transaction.reversed`, and `transaction.preauthorized`.
With `--json`, `listen` also requires `--timeout`.

Use `listen --verify-signature` to validate GP's POST signature before forwarding.
The listener is still loopback-only: receiving real notifications requires an
approved public HTTPS endpoint or relay that forwards to it. Verification does
not distinguish a GP notification from a locally generated event signed with the
same key. Never expose the local listener directly to the internet.

---

### `globalpayments agent setup`
Install the Global Payments MCP server and SDK skills from
[`globalpayments/agent-skills`](https://github.com/globalpayments/agent-skills) for
detected or explicitly selected Claude Code, Cursor, or VS Code projects. Setup is
sandbox-only and writes editor configuration plus a managed section in `AGENTS.md`.
Setup and the launcher read credentials from `.env`; existing process environment
variables take precedence. Credentials are not copied into editor settings. Its
local MCP installation is ignored in `.gitignore`. Requires Git, npm, network access,
and Node.js 22.20 or newer. The MCP server is built from a pinned official GitHub
revision, and the SDK skills are installed with a pinned `skills` CLI from a pinned
`agent-skills` commit. Installer processes (git, npm, npx) do not receive the GP
credentials. That revision exposes documentation lookup and payment-link creation and
retrieval, not generic API requests or transaction lookup. In sandbox mode it
requests an access token from `https://apis-cert.globalpay.com` and sends payment-link
requests to `https://apis.sandbox.globalpay.com`.

```bash
globalpayments agent setup --editor vscode
```

---

### `globalpayments cases list`
List every resolved certification case with its canonical address.

**Options:**
- `--config <path>` — Config file path (optional)
- `--pack <packId...>` — Activate one or more packs (space-separated)
- `--profile <name>` — Activate profile-defined packs (from config)
- `--cert <name>` — Shorthand for a single `--pack`
- `--required-only` — Restrict output to required cases
- `--tag <tag...>` — Restrict output to cases carrying all of these tags
- `--json` — Machine-readable output

**Example:**
```bash
globalpayments cases list --cert global-core
# Global Core (global-core v1.0.0)
#   1 case(s), 1 required
#
#   global-core:basic-sale-approved — Basic sale approved (REQUIRED) [smoke]
```

Case addresses are formatted `<packId>:<caseId>` and are identical across
`cases list`, `cases show`, `run`, `watch`, `report`, and `diagnose`.
The `global-core:basic-sale-approved` smoke case accepts a captured CNP sale in
any currency, including EUR and USD; it does not enforce a particular amount.

---

### `globalpayments cases show <caseAddress>`
Display one fully resolved case definition (matcher rules + expectations).

**Options:**
- `--config <path>` — Config file path (optional)
- `--json` — Machine-readable output

**Example:**
```bash
globalpayments cases show global-core:basic-sale-approved --json
```

---

### `globalpayments watch`
Poll for case matches in real-time. Continuously fetches transactions, evaluates all cases, and updates the screen. Useful for exploratory testing and debugging matcher rules.

**Options:**
- `--config <path>` — Config file (optional; omit to use env vars only)
- `--env-file <path>` — Env file to load (default: `.env`)
- `--timeout <duration>` — Max poll time (e.g., `10m`, `5s`; default: `10m`)
- `--pack <packId...>` — Activate additional pack(s) (space-separated)
- `--profile <name>` — Activate profile-defined packs (from config)
- `--cert <name>` — Activate a bundled certification suite by name (shorthand for `--pack`)

**Exit codes:** see the [exit-code table](#exit-codes). `0` when all required cases
pass, `1` when they do not, and a distinct code for config, auth, and network faults.

**Illustrative output** (your terminal layout and cases may differ):
```
Polling (elapsed: 2m 15s | fetched: 234 txns | window: 15m)

✓ global-core:basic-sale-approved [PASS]
○ global-ecommerce:3ds-sale [PEND] — Awaiting match

Recent transactions:
  14:32:01  SALE  CAPTURED  100 USD  Visa ····1234  [00]
  14:31:58  SALE  DECLINED  50 USD   MC ····5678    [05]
```

---

### `globalpayments run`
CI-friendly mode: poll until all required cases pass or the timeout is reached,
then persist a result and exit. Use in automated pipelines.

**Options:**
- `--config <path>` — Config file (optional; omit to use env vars only)
- `--env-file <path>` — Env file to load (default: `.env`)
- `--timeout <duration>` — Max poll time (e.g., `5m`, `30s`; default: `5m`)
- `--pack <packId...>` — Activate additional pack(s) (space-separated)
- `--profile <name>` — Activate profile-defined packs (from config)
- `--cert <name>` — Activate a bundled certification suite by name (shorthand for `--pack`)
- `--json` — Output JSON instead of pretty-printed results

**Exit codes:** see the [exit-code table](#exit-codes). Notably `1` means the run
completed and required cases are not passing — distinct from `3` (config), `4` (auth),
and `5` (network), so a pipeline can tell a genuine certification failure from an
infrastructure fault.

**Example (GitHub Actions):**
```yaml
- name: Validate certification
  run: |
    npx @globalpayments/cli run \
      --cert global-core \
      --timeout 5m \
      --json > results.json || status=$?
    cat results.json
    exit "${status:-0}"
```

---

### `globalpayments report`
Read a persisted result artifact and re-render it without re-running. Emits a warning
when the artifact's `schemaVersion` does not match the one this build expects.

**Options:**
- `--input <path>` — Result JSON file (default: `.globalpayments/results/latest.json`)
- `--json` — Machine-readable output

**Example:**
```bash
globalpayments report --json
```

---

### `globalpayments diagnose`
Explain why cases are not passing and what to change in the request to make them pass.
Reads the last persisted result, so it performs no network calls and needs no
credentials.

`report` tells you a case is red. `diagnose` tells you why, at field level, and what to
send instead.

For each non-passing case it reports:

- **`code`** — the stable cause: `OBSERVATION_FAILED`, `NO_TRANSACTIONS_OBSERVED`,
  `NO_NEAR_MATCH`, `MATCHER_MISMATCH`, `EXPECTATION_VIOLATED`, or `AMBIGUOUS_MATCH`
- **`nearMisses`** — the closest transactions actually observed, scored, with the exact
  matcher fields that differed and their expected vs observed values
- **`fixes`** — ordered corrective actions, each carrying `field`, `currentValue`, and
  `requiredValue` so an automated caller never parses prose
- **`requiredRequest`** — the canonical request that satisfies the case, and the outcome
  it must produce
- **`fixPlan`** (top level) — every fix across every case, flattened and ordered
  most-specific-first. Apply it top to bottom.

**Arguments:**
- `[caseAddress]` — Restrict to one case, formatted `<packId>:<caseId>`

**Options:**
- `--input <path>` — Result JSON file (default: `.globalpayments/results/latest.json`)
- `--json` — Machine-readable output

**Example:**
```bash
globalpayments diagnose --json
globalpayments diagnose global-ecommerce:3ds-challenge --json
```

Typical output for a case that saw no match:

```
○ global-ecommerce:3ds-challenge  MATCHER_MISMATCH
    No transaction matched. The closest one (id TRN_ccc) satisfied 2 of 3 matcher
    field(s); `amount` differs.

    closest observed: TRN_ccc — 2/3 matcher fields, 67%
      ✓ type
      ✓ channel
      ✗ amount  expected 2002  observed 1001

    to make it pass:
      1. [high] Set `amount` to 2002 in the request you send. The closest observed
         transaction (id TRN_ccc) used 1001.
```

Because certification commands only observe, every fix is an instruction about the
transaction **you** send — never a change to the certification runner.

Note that `diagnose` exits `0` even when the run it is reading failed: it is a
read-only inspection command, so it stays usable inside a fix loop. Branch on
`globalpayments run` for pass/fail.

## Configuration

### Config File Format

Create `.globalpayments/config.yaml`:

```yaml
version: 1

# Required: GP API environment
environment: sandbox  # or: production

# Required: authentication credentials
auth:
  mode: app-credentials
  appId: ${GP_API_APP_ID}           # from environment or literal
  appKey: ${GP_API_APP_KEY}
  apiVersion: 2021-03-22           # GP API version

# Optional: restrict matching to specific account
account:
  accountName: ${GP_API_ACCOUNT_NAME}

# Optional: polling tuning
polling:
  intervalMs: 3000              # poll interval (default: 3000)
  lookbackMinutes: 15           # transaction window (default: 10)
  overlapSeconds: 30            # overlap between windows (default: 30)
  pageSize: 100                 # transactions per page (default: 100)
  order: DESC                   # DESC (newest first) or ASC (default: DESC)

# Optional: custom pack directory
packs:
  directory: ./packs            # relative to config directory

# Packs to load on startup
activePacks:
  - global-core
  - global-ecommerce
```

### Environment Variables

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `GP_API_APP_ID` | GP API app ID | yes | `ba3b...` |
| `GP_API_APP_KEY` | GP API app key | yes | `Afje...` |
| `GP_API_ACCOUNT_NAME` | Account to match (optional filter) | no | `my-integration` |
| `GP_API_ENVIRONMENT` | GP environment | no (default: `sandbox`) | `sandbox` or `production` |
| `GP_API_VERSION` | GP API version | no (default: `2021-03-22`) | `2021-03-22` |

Credentials and configuration are read by `globalpayments doctor` and the polling
commands. `init` writes templates; it does not validate credentials.

## How Polling Works

Each polling cycle:

1. **Fetch observations** — Query GP API for recent records in a sliding time window:
   `GET /transactions` for transaction cases, `GET /actions` for actions cases. A feed
   is only polled when an active case uses it.
2. **Evaluate all cases** — For each active case, find matching observations
3. **Apply latest-match-wins** — Re-evaluate each case using the newest match in the window
4. **Wait/repeat** — Sleep for `polling.intervalMs`, then repeat until all required cases pass or the timeout is reached

After the run or watch ends, it writes `.globalpayments/results/latest.json` and
timestamped history.

**Time window logic:**
- `lookbackMinutes` — How far back to look from now
- `overlapSeconds` — Overlap to previous window (prevents missing matches at boundaries)
- Each cycle slides forward by ~`intervalMs`

**If no transactions match:**
- Case remains pending (no fail)
- If timeout is reached, case is reported pending with a "no matches found" reason
- Read `globalpayments diagnose` for the cause and any available near matches.
  When no suitable near match exists, there may be no field-level comparison.

**If multiple matches exist:**
- Only the newest match (by `timeCreated`) is used for evaluation
- If two matches are equally recent, case fails with "ambiguous match" reason

## Case Definitions

Cases use YAML format with three parts: **matcher**, **expectations**, and optional **evaluator**.

### Source

`source` selects the GP API feed a case is judged against. It defaults to `transactions`.

| `source` | Feed | `type` means | `status` means | `responseCode` means |
|---|---|---|---|---|
| `transactions` | `GET /transactions` | `SALE` or `REFUND` | transaction status (`CAPTURED`, `PREAUTHORIZED`, …) | gateway result, often absent |
| `actions` | `GET /actions` — the log of every API request | action type (`PAYER_CREATE`, `CAPTURE`, `VERIFY`, …) | resource status | HTTP status of the request (`"200"`) |

Actions cases reach every API endpoint, including ones that never create a transaction
(payers, tokens, disputes, settlement, merchants). Typical shape:

```yaml
source: actions
matcher:
  type: PAYER_CREATE     # action type
  resource: PAYERS       # optional: GP resource
expect:
  latest:
    responseCodeIn: ["200", "201"]
```

Things to know about the actions feed:
- The app running `globalpayments` needs permission to list actions (`ACT_GET_List`).
- `CREATE_TOKEN`, `TRANSACTION_LIST`, and `ACTION_LIST` issued by the observing app are
  ignored, because `globalpayments` makes those calls itself while polling.
- A rejected request is logged too, so the case fails with the HTTP status and GP
  error code instead of staying pending.
- Bundled actions cases are tagged `action-type-confirmed`, `action-type-documented`, or
  `action-type-inferred`. Inferred cases are optional; if one stays pending,
  diagnosis may identify near matches, but cannot guarantee the logged action type
  will be visible. `npm run verify:actions` checks action types against a GP sandbox
  and can create sandbox resources; use it only when you intend to make those writes.

### Matcher
Defines which observations to match. Composite and card fields must match. Reference
matching uses a strategy ladder: exact reference, then prefix where available, then a
composite match that ignores reference. A reference mismatch alone cannot prevent a match.

```yaml
matcher:
  reference: cert-sale-001        # preferred exact reference
  referencePrefix: cert-          # preferred prefix if exact reference does not match
  type: SALE                      # transaction type
  amount: 100                      # amount (ignores decimal)
  currency: USD                    # currency code
  channel: CNP                     # card-not-present
  accountName: my-account          # account name
  cardBrand: Visa                  # Visa, Mastercard, etc.
  last4: "1234"                    # last 4 digits of card
  resource: PAYERS                 # GP resource (actions cases)
```

### Expectations
Define what status/response the latest matching observation should have. The default
evaluator skips `responseCodeIn` when the response code is absent; the transactions
list endpoint commonly omits it.

```yaml
expect:
  latest:
    statusIn:
      - CAPTURED              # one of these statuses
      - CAPTURED_PENDING
    responseCodeIn:
      - "00"                  # optional: check response code
```

### Evaluator (Optional)
The schema accepts evaluator configuration, but the current CLI does not load custom
evaluator scripts. The built-in evaluator checks `expect.latest`; sequence and
aggregate expectations are not currently evaluated by it.

### Example Case File

Example custom case file (`packs/my-pack/cases/sale-approved.yaml`):
```yaml
id: sale-approved
name: Sale approved
required: true
tags: [core, e-commerce]
mode: latest

matcher:
  referencePrefix: cert-sale-
  type: SALE
  currency: USD
  accountName: integration-test

expect:
  latest:
    statusIn: [CAPTURED]
    responseCodeIn: ["00"]
```

## Result Artifacts

After a `run` or `watch` completes, results are written to:

- **Latest:** `.globalpayments/results/latest.json`
- **History:** `.globalpayments/results/history/<timestamp>.json`

### Result JSON example

An excerpt of a persisted result (redacted configuration omitted):

```json
{
  "schemaVersion": 1,
  "timestamp": "2024-08-13T14:32:45.123Z",
  "environment": "sandbox",
  "activePacks": ["global-core"],
  "verdict": "passed",
  "summary": { "total": 1, "pass": 1, "fail": 0, "pending": 0 },
  "required": { "total": 1, "passing": 1, "failing": 0 },
  "cases": [
    {
      "namespacedCaseId": "global-core:basic-sale-approved",
      "packId": "global-core",
      "caseId": "basic-sale-approved",
      "status": "pass",
      "reason": "Latest matching transaction satisfies expectation",
      "matchedCount": 1,
      "latestMatch": {
        "id": "txn-abc123",
        "timeCreated": "2024-08-13T14:31:58Z",
        "type": "SALE",
        "status": "CAPTURED",
        "amount": 100,
        "currency": "USD"
      }
    }
  ]
}
```

## Integration with CI/CD

### GitHub Actions Example
```yaml
name: Certification Validation

on: [push]

jobs:
  certify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Validate certification
        env:
          GP_API_APP_ID: ${{ secrets.GP_APP_ID }}
          GP_API_APP_KEY: ${{ secrets.GP_APP_KEY }}
          GP_API_ENVIRONMENT: sandbox
        run: |
          npx @globalpayments/cli run --cert global-core --timeout 5m --json

      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: certification-results
          path: .globalpayments/results/
```

## Authentication & Security

### Credential Handling

- **Never hardcode credentials** — Always use environment variables
- **Config is redacted** — Sensitive keys (`appKey`, `appId`, etc.) are masked in persisted config summaries
- **Certification is read-only** — `run` and `watch` only observe; `api post` can send requests only to sandbox
- **Credentials are never logged** — Auth failures show only error codes, not secrets

### Recommended Practices

- Use a dedicated sandbox app for local API writes and synthetic webhook testing
- Rotate credentials regularly
- Store secrets in your CI/CD provider (GitHub Secrets, GitLab CI/CD variables, etc.)
- Run certification observer in a separate environment from your integration

## Troubleshooting

### **Error: `Invalid credentials`**
- **Cause:** App ID or app key is incorrect, expired, or lacks permissions
- **Solution:**
  1. Verify credentials in GP Developer Portal
  2. Confirm the account has API access enabled
  3. Try `globalpayments doctor --json` to debug

### **Error: `No transactions found`**
- **Cause:** Poll window is too small, or your integration hasn't submitted transactions yet
- **Solution:**
  1. Increase `polling.lookbackMinutes` in config (default: 10)
  2. Ensure your integration is actively submitting test transactions
  3. Check that `accountName` in matcher rules matches your GP account
  4. Run `globalpayments doctor` to check authentication and connectivity

### **Error: `Ambiguous match` on a case**
- **Cause:** Multiple transactions match with identical timestamp
- **Solution:**
  1. Re-send the scenario once, alone, with a distinct reference
  2. Check the applicable composite matcher fields with `globalpayments cases show <packId>:<caseId>`

### **Watch mode exits after timeout with partial results**
- **Cause:** Timeout reached before all required cases passed
- **Solution:**
  1. Increase `--timeout` (e.g., `--timeout 15m`)
  2. Check transaction submission in your integration (may be too slow)
  3. Review `.globalpayments/results/latest.json` to see which cases are pending

### **Port or file permission errors**
- **Cause:** `.globalpayments/` directory lacks write permissions, or another process is using the port
- **Solution:**
  1. Ensure `.globalpayments/` exists and is writable: `mkdir -p .globalpayments && chmod 755 .globalpayments`
  2. Check for running globalpayments processes: `ps aux | grep globalpayments`

### **Matcher rules not matching transactions**
- **Cause:** Matcher fields don't align with actual transaction structure
- **Solution:**
  1. Run `globalpayments watch --cert <packId>` to see recent transactions in real-time
  2. Compare transaction fields to your matcher criteria
  3. Use `globalpayments cases show <packId>:<caseId>` to review the full case definition
  4. Use `globalpayments diagnose` for available field-level details

## Programmatic API

The current build bundles the command-line entry point only; it does not produce
the module entry point or subpath modules needed for a published programmatic API.
For automation, invoke the CLI with `--json` and consume its envelope and exit code.

## Testing

```bash
npm run verify        # typecheck + tests + build + build-level smoke
npm test              # Unit suite, single run
npm run test:watch    # Watch mode
npm run smoke         # Contract checks against dist/bin.js (requires a build)
```

`npm run verify` is the command to run before calling a change done. The unit suite
runs in-source and therefore cannot observe faults that exist only in the bundled
artifact — path anchoring, packaging, stdout purity, and the CLI's exit codes.
`scripts/smoke.mjs` invokes the built binary the way a real caller would, with
credentials blanked so it never touches the network.

Coverage includes:
- The output contract: envelope invariants, exit-code taxonomy, error-code stability
- Case addressing (`<packId>:<caseId>`) and pack inheritance resolution
- Config loading and schema validation
- Auth provider and GP API client
- Matcher logic and case evaluation
- Polling state machine and window management
- Result persistence and redaction
- Diagnostics and error messages

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit, strict
npm run build         # Compile to dist/ and copy src/packs -> dist/packs
npm run dev -- <args> # Run from source (tsx)
npm run verify        # Everything

# Try the CLI locally
node dist/bin.js explain --json
node dist/bin.js packs list
node dist/bin.js doctor
```

See [AGENTS.md](AGENTS.md) for the machine contract and the internal architecture.

## Contributing

Contributions are welcome. Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Run `npm run verify` before submitting a PR
5. Follow existing code style (TypeScript strict mode, no `any`)

## Resources

- [Global Payments Developer Portal](https://developer.globalpayments.com/)
- [GP API Reference](https://developer.globalpayments.com/api/references-overview)
- [API Documentation](https://developer.globalpayments.com/)
- [Support](https://developer.globalpayments.com/support)

## License

MIT — See LICENSE file for details.

---

**Questions?** Open an issue on [GitHub](https://github.com/globalpayments/globalpayments-cli/issues) or contact [CommunityExperience@globalpayments.com](mailto:CommunityExperience@globalpayments.com).
