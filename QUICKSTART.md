# Global Payments CLI — Quickstart

**Get from a fresh clone to a certification result in five minutes.**

## Install

```bash
git clone https://github.com/globalpayments/globalpayments-cli.git
cd globalpayments-cli
npm install
npm run build

node dist/bin.js --help
```

No Node.js/npm? Use Docker instead — skip the `npm install`/`npm run build` steps above and run every `npm run dev -- <command>` in this guide as `docker compose run --rm globalpayments <command>` (e.g. `docker compose run --rm globalpayments --help`).

## Set Up Credentials

For an existing sandbox app, open the [Global Payments Developer Portal](https://developer.globalpayments.com),
then run the interactive setup. It hides the app key and writes the credentials to `.env`;
it adds an ignore rule when needed and does not create an account or app.

```bash
npm run dev -- sandbox create
```

Or configure the same values directly:

```bash
# Option 1: environment variables (recommended for CI)
export GP_API_APP_ID="your-app-id"
export GP_API_APP_KEY="your-app-key"
export GP_API_ENVIRONMENT="sandbox"    # optional; sandbox is the default

# Option 2: Config file
npm run dev -- init --with-config
# Non-interactive — writes .env.example and globalpayments.config.yaml
# Pass --config globalpayments.config.yaml when using that generated config.
```

## Verify your setup

```bash
npm run dev -- doctor
```

```
globalpayments readiness

  ✓ Env file loaded
      Loaded .env.
  ✓ Configuration resolved
      No config file; derived entirely from environment variables.
  ✓ Credentials present
      appId and appKey are set (values redacted).
  ✓ GP API token exchange
      Token acquired from https://apis.sandbox.globalpay.com/ucp; type=Bearer, expiresIn=86399s.
  ✓ Certification suites available
      13 bundled suite(s): global-3ds, global-alternative-payments, global-auth-lifecycle, global-card-present, global-core, global-disputes, global-ecommerce, global-multicurrency, global-pay-by-link, global-payment-actions, global-platform, global-reporting, global-tokenization

Ready for certification runs.
```

If a check fails it reports the error code and exactly how to fix it.

## Discover what you can run

```bash
npm run dev -- packs list
npm run dev -- cases list --cert global-core
```

Case addresses are formatted `<packId>:<caseId>` — for example
`global-core:basic-sale-approved`. The same address identifies that case in every
command and in every saved result.

```bash
npm run dev -- cases show global-core:basic-sale-approved
```

## Run a certification

Certification commands are observers: they evaluate transactions already sent by
your integration. The separate `api post` command can send requests, but is sandbox-only.

```bash
# CI mode: evaluate once, persist, exit non-zero if required cases fail
npm run dev -- run --cert global-core --timeout 5m

# Live mode: poll continuously with a real-time UI
npm run dev -- watch --cert global-core
```

## Use the full CLI

```bash
# Read resources or send a sandbox API request (provide a valid endpoint body)
npm run dev -- api get /transactions
npm run dev -- api post /transactions --data-file request.json
npm run dev -- transactions get <transaction-id>

# Initiate a real sandbox TestPay sale using endpoints you control
npm run dev -- transactions testpay --status-url https://YOUR-HOST/status --return-url https://YOUR-HOST/return

# Follow rejected API actions
npm run dev -- logs tail --status 4xx

# Test a local webhook handler; listener binds to loopback only
npm run dev -- listen --forward-to http://localhost:3000/webhooks
npm run dev -- trigger transaction.captured

# Install MCP tools and SDK skills for an AI editor
npm run dev -- agent setup --editor vscode
```

`trigger` sends a signed synthetic event; it does not register a real GP webhook.
TestPay requires an approved public HTTPS status endpoint and return endpoint; complete
the returned checkout to request a status notification. `listen --verify-signature`
can verify forwarded POSTs, but the listener itself is only accessible on loopback.
An API success does not prove a real webhook was delivered.
Agent setup requires Git, npm, network access, Node.js 22.20 or newer, and sandbox credentials.

## Review results

```bash
npm run dev -- report
```

Results are persisted to `.globalpayments/results/latest.json` and archived under
`.globalpayments/results/history/`.

## Turn a red case green

`report` tells you a case is red. `diagnose` tells you why, at field level, and what to
send instead.

```bash
npm run dev -- diagnose
npm run dev -- diagnose global-core:basic-sale-approved
```

For each non-passing case it names the closest transaction it actually observed, the
exact matcher field that differed, and the change to make to your request:

```
○ global-core:basic-sale-approved  MATCHER_MISMATCH
    closest observed: TRN_ccc — 2/3 matcher fields, 67%
      ✗ amount  expected 2002  observed 1001

    to turn this green:
      1. [high] Set `amount` to 2002 in the request you send.
```

It reads the saved result, so it needs no credentials and makes no network calls.

## Automating it

Every command accepts `--json` and emits a single envelope on stdout:

```bash
npm run dev -- run --cert global-core --json
```

```jsonc
{
  "ok": false,
  "exitCode": 1,
  "data": { "verdict": "failed", "required": { "total": 1, "passing": 0, "failing": 1 } },
  "error": { "code": "E_CERT_REQUIRED_CASES_FAILING", "remediation": "..." },
  "nextActions": [{ "reason": "...", "command": "globalpayments cases list --cert global-core --json" }]
}
```

For the complete contract in one call:

```bash
npm run dev -- explain --json
```

See [AGENTS.md](AGENTS.md) for the full automation guide.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Required cases not passing (a certification result, not a tool error) |
| 2 | Bad invocation |
| 3 | Config problem |
| 4 | Auth problem |
| 5 | Network problem (retryable) |
| 6 | Unknown pack, case, or result |
| 7 | Internal bug |
| 8 | GP API rejected the request |
| 9 | Local webhook delivery failed |
| 10 | Agent/MCP setup failed |

## Useful commands

| Command | Purpose |
|---|---|
| `npm test` | Run the test suite |
| `npm run typecheck` | Type-check |
| `npm run dev -- explain` | Full CLI contract |
| `npm run dev -- doctor --json` | Structured readiness report |
| `npm run dev -- packs list` | Available certification suites |
| `npm run dev -- diagnose` | Why cases are red and what to change |
| `npm run dev -- api get /transactions --json` | Read a GP API resource |
| `npm run dev -- logs tail --status 4xx` | Follow rejected API requests |
| `npm run dev -- listen --forward-to http://localhost:3000/webhooks` | Test a local webhook handler |

## Common issues

### Everything is `pending`

This is the normal first result and usually not an error. Check
`data.observation.transactionsObserved`:

- **`0`** — nothing was in the polling window. Send the transactions the suite expects,
  or widen `polling.lookbackMinutes` in your config.
- **`> 0`** — transactions arrived but none matched. Run `globalpayments diagnose`; it names
  the closest transaction it saw and the exact matcher field that differed.

### `E_AUTH_INVALID_CREDENTIALS` (exit 4)

```bash
echo $GP_API_APP_ID          # confirm the values are present
npm run dev -- doctor --json # isolate which check fails
```

Confirm `GP_API_ENVIRONMENT` matches the environment the credentials belong to.

### `E_CONFIG_READ` (exit 3)

You passed `--config <path>` and the file does not exist. Either fix the path or drop
the flag entirely and configure from environment variables.

## Next steps

1. **[README.md](README.md)** — all commands, config options, and case definitions
2. **[AGENTS.md](AGENTS.md)** — the machine contract and internal architecture
3. **[CONTRIBUTING.md](CONTRIBUTING.md)** — adding cases or modifying the tool
4. **Integrate into CI:**
   ```yaml
   - name: Validate certification
     run: npx @globalpayments/cli run --cert global-core --timeout 5m --json
   ```

---

**You're ready.** Start with `npm run dev -- doctor` and go from there.
