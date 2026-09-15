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

```bash
# Option 1: environment variables (recommended for CI)
export GP_API_APP_ID="your-app-id"
export GP_API_APP_KEY="your-app-key"
export GP_ENVIRONMENT="sandbox"        # optional; sandbox is the default

# Option 2: Config file
npm run dev -- init --with-config
# Non-interactive — writes .env.example and .gpcli/config.yaml; edit them directly
```

> Note the variable is `GP_ENVIRONMENT`, not `GP_API_ENVIRONMENT`.

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
      2 bundled suite(s): global-core, global-ecommerce

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

`globalpayments` is an **observer**: it never creates transactions. Send the transactions the
suite expects from your integration, then let `globalpayments` judge them.

```bash
# CI mode: evaluate once, persist, exit non-zero if required cases fail
npm run dev -- run --cert global-core --timeout 5m

# Live mode: poll continuously with a real-time UI
npm run dev -- watch --cert global-core
```

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

## Useful commands

| Command | Purpose |
|---|---|
| `npm test` | Run the test suite |
| `npm run typecheck` | Type-check |
| `npm run dev -- explain` | Full CLI contract |
| `npm run dev -- doctor --json` | Structured readiness report |
| `npm run dev -- packs list` | Available certification suites |
| `npm run dev -- diagnose` | Why cases are red and what to change |

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

Confirm `GP_ENVIRONMENT` matches the environment the credentials belong to.

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
