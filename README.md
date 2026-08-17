# @globalpayments/cli

**Certification observer CLI for Global Payments — polls transactions, matches certification test cases, and evaluates pass/fail without submitting transactions.**

This tool is an observer-only client that runs outside your integration, validating that your system is correctly processing payments according to Global Payments certification requirements. It uses the GP API to poll recent transactions, matches them against case definitions (matcher rules + expectations), applies latest-match-wins logic, and persists structured results for local review and CI/CD integration.

## Features

- **Observer-only operation** — No transaction submission; runs alongside your integration for external validation
- **Latest-match-wins evaluation** — Each case re-evaluates against the newest matching transaction in the poll window
- **Certification pack system** — Modular, inheritable pack definitions with cases, matchers, and expectations
- **Safe credential handling** — Redacted config output; credentials loaded from environment or secure config
- **Sliding time-window polling** — Configurable overlap, page size, and poll interval; handles partial results gracefully
- **Multiple evaluation modes** — Latest (single newest match), sequence (ordered matches), and aggregate (match counts)
- **Graceful failure handling** — Timeout with partial results, ambiguous-match detection, detailed error messages
- **Persistent result artifacts** — JSON output for CI consumption; timestamped history in `.gpcli/results/`
- **CLI + programmatic API** — Use as command-line tool or import as Node.js module

## Installation

### Via npm (published package)
```bash
npm install --save-dev @globalpayments/cli
# or
npx @globalpayments/cli --help
```

### Local development
```bash
git clone https://github.com/globalpayments/globalpayments-cli.git
cd globalpayments-cli
npm install
npm run build
node dist/bin.js --help
```

## Requirements

- **Node.js** ≥ 20
- **Global Payments API credentials** (app ID + app key for your integration)
- **Sandbox/production account** with transaction access

## Quick Start

### 1. Set up credentials
```bash
export GP_API_APP_ID="your-app-id"
export GP_API_APP_KEY="your-app-key"
export GP_API_ACCOUNT_NAME="your-account-name"  # optional; restricts matching to one account
export GP_API_ENVIRONMENT="sandbox"              # or: production
```

Or generate `.gpcli/config.yaml`:
```bash
npx @globalpayments/cli init --with-config
# Writes .env.example (always) and .gpcli/config.yaml (with --with-config)
# Non-interactive — edit the generated files directly
```

### 2. List available certification cases
```bash
npx @globalpayments/cli cases list --config .gpcli/config.yaml
# Shows all cases by pack; use --pack <packId> to filter
```

### 3. Run certification observer
```bash
# Watch mode: polls for up to 10 minutes, updates screen in real-time
npx @globalpayments/cli watch --config .gpcli/config.yaml --timeout 10m

# CI mode: single run, exit non-zero if required cases don't pass
npx @globalpayments/cli run --config .gpcli/config.yaml --timeout 5m --json
```

### 4. Review results
```bash
npx @globalpayments/cli report --input .gpcli/results/latest.json
# Pretty-prints pass/fail summary with reasons
```

## CLI Commands

### `gpcli init`
Non-interactive scaffolding — writes template files, no prompts. Always writes `.env.example`; add `--with-config` to also write `.gpcli/config.yaml` (the same default path every other command reads from).

**Options:**
- `--dir <path>` — Output directory (default: `.`)
- `--with-config` — Also generate `.gpcli/config.yaml`

---

### `gpcli doctor`
Validate GP API access and resolve active certification packs without polling. Safe to run before watch/run.

**Output:**
- Auth status (valid credentials, token expiry, account access)
- Resolved packs and case count
- Config redaction summary
- Suggested next steps

**Options:**
- `--config <path>` — Config file (optional; omit to use env vars only)
- `--env-file <path>` — Env file to load (default: `.env`)

---

### `gpcli auth test`
Quick auth validation: fetch an access token, confirm scope, and verify account access.

**Options:**
- `--config <path>` — Config file (default: `.gpcli/config.yaml`)
- `--env-file <path>` — Env file to load (default: `.env`)

**Example:**
```bash
gpcli auth test --config .gpcli/config.yaml
# Output: ✓ Valid credentials | Token expires: 2024-08-13T12:34:56Z | Scope: transactions:read
```

---

### `gpcli cases list`
List all resolved certification cases grouped by pack.

**Options:**
- `--config <path>` — Config file (default: `.gpcli/config.yaml`)
- `--pack <packId...>` — Activate one or more packs (space-separated)
- `--profile <name>` — Activate profile-defined packs (from config)

**Example:**
```bash
gpcli cases list --config .gpcli/config.yaml --pack global-core eu-ecommerce
# Output:
# Global Core
#   Version: 1.0.0 | Region: EMEA
#   sale-approved - Sale approved (REQUIRED)
#   sale-declined - Sale declined (optional)
# ...
```

---

### `gpcli cases show <caseId>`
Display full resolved case definition (matcher rules + expectations).

**Options:**
- `--config <path>` — Config file (default: `.gpcli/config.yaml`)

**Example:**
```bash
gpcli cases show global-core:sale-approved --config .gpcli/config.yaml
# Output: Case details with matcher, expectations, tags, evaluator config
```

---

### `gpcli watch`
Poll for case matches in real-time. Continuously fetches transactions, evaluates all cases, and updates the screen. Useful for exploratory testing and debugging matcher rules.

**Options:**
- `--config <path>` — Config file (optional; omit to use env vars only)
- `--env-file <path>` — Env file to load (default: `.env`)
- `--timeout <duration>` — Max poll time (e.g., `10m`, `5s`; default: `10m`)
- `--pack <packId...>` — Activate additional pack(s) (space-separated)
- `--profile <name>` — Activate profile-defined packs (from config)
- `--cert <name>` — Activate a bundled certification suite by name (shorthand for `--pack`)

**Exit code:**
- `0` — Timeout or user interrupt; results persisted
- `1` — Auth error, config error, or unrecoverable failure

**Output:**
```
Polling (elapsed: 2m 15s | fetched: 234 txns | window: 15m)

✓ global-core:sale-approved [PASS]
✗ global-core:sale-declined [FAIL] — No matches found
○ eu-ecommerce:3ds-sale [PEND] — Awaiting match

Recent transactions:
  14:32:01  SALE  CAPTURED  100 USD  Visa ····1234  [00]
  14:31:58  SALE  DECLINED  50 USD   MC ····5678    [05]
```

---

### `gpcli run`
CI-friendly mode: single polling cycle, exit non-zero if any required cases fail. Use in automated pipelines.

**Options:**
- `--config <path>` — Config file (optional; omit to use env vars only)
- `--env-file <path>` — Env file to load (default: `.env`)
- `--timeout <duration>` — Max poll time (e.g., `5m`, `30s`; default: `5m`)
- `--pack <packId...>` — Activate additional pack(s) (space-separated)
- `--profile <name>` — Activate profile-defined packs (from config)
- `--cert <name>` — Activate a bundled certification suite by name (shorthand for `--pack`)
- `--json` — Output JSON instead of pretty-printed results

**Exit code:**
- `0` — All required cases passing
- `1` — Any required case failing, auth error, or config error

**Example (GitHub Actions):**
```yaml
- name: Validate certification
  run: |
    npx @globalpayments/cli run \
      --config .gpcli/config.yaml \
      --timeout 5m \
      --json > results.json
    cat results.json
```

---

### `gpcli report`
Display a persisted result JSON file in human-readable format.

**Options:**
- `--input <path>` — Result JSON file (default: `.gpcli/results/latest.json`)

**Example:**
```bash
gpcli report --input .gpcli/results/2024-08-13T10-32-45Z.json
```

## Configuration

### Config File Format

Create `.gpcli/config.yaml`:

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
  - eu-ecommerce
  - us-retail
```

### Environment Variables

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `GP_API_APP_ID` | GP API app ID | yes | `ba3b...` |
| `GP_API_APP_KEY` | GP API app key | yes | `Afje...` |
| `GP_API_ACCOUNT_NAME` | Account to match (optional filter) | no | `my-integration` |
| `GP_API_ENVIRONMENT` | GP environment | no (default: `sandbox`) | `sandbox` or `production` |
| `GP_API_VERSION` | GP API version | no (default: `2021-03-22`) | `2021-03-22` |

All commands load `.env` automatically (override with `--env-file <path>`). Variables are read directly when no `--config` file is used, or substituted into a config file's `${VAR}` placeholders otherwise.

## How Polling Works

Each polling cycle:

1. **Fetch transactions** — Query GP API for recent transactions in a sliding time window
2. **Evaluate all cases** — For each active case, find matching transactions
3. **Apply latest-match-wins** — Re-evaluate each case using only the newest match in the window
4. **Persist results** — Write `.gpcli/results/latest.json` and timestamped history
5. **Wait/repeat** — Sleep for `polling.intervalMs`, then repeat (or exit if timeout)

**Time window logic:**
- `lookbackMinutes` — How far back to look from now
- `overlapSeconds` — Overlap to previous window (prevents missing matches at boundaries)
- Each cycle slides forward by ~`intervalMs`

**If no transactions match:**
- Case remains pending (no fail)
- If timeout is reached, case is reported pending with a "no matches found" reason

**If multiple matches exist:**
- Only the newest match (by `timeCreated`) is used for evaluation
- If two matches are equally recent, case fails with "ambiguous match" reason

## Case Definitions

Cases use YAML format with three parts: **matcher**, **expectations**, and optional **evaluator**.

### Matcher
Defines which transactions to match. AND semantics (all specified fields must match).

```yaml
matcher:
  reference: cert-sale-001        # exact match on reference
  referencePrefix: cert-          # or: prefix match
  type: SALE                      # transaction type
  amount: 100                      # amount (ignores decimal)
  currency: USD                    # currency code
  channel: CNP                     # card-not-present
  accountName: my-account          # account name
  cardBrand: Visa                  # Visa, Mastercard, etc.
  last4: "1234"                    # last 4 digits of card
```

### Expectations
Define what status/response the matched transaction should have. Currently supports `latest` (single newest match).

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
For complex pass/fail logic, provide a custom JavaScript evaluator function:

```yaml
evaluator:
  type: script              # or: declarative
  script: evaluators/my-case.js
  export: default           # or: named export
```

Evaluator function signature:
```typescript
export default function evaluateCase(
  caze: CertificationCase,
  matches: ObservedTxn[],
  context: EvaluationContext
): CaseEvaluationResult;
```

### Example Case File

`packs/global-core/cases/sale-approved.yaml`:
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

After each polling cycle, results are written to:

- **Latest:** `.gpcli/results/latest.json`
- **History:** `.gpcli/results/history/<timestamp>.json`

### Result JSON Schema

```json
{
  "timestamp": "2024-08-13T14:32:45.123Z",
  "elapsed": "2m15s",
  "transactionsFetched": 234,
  "pollWindow": {
    "from": "2024-08-13T14:17:45.123Z",
    "to": "2024-08-13T14:32:45.123Z"
  },
  "cases": [
    {
      "namespacedId": "global-core:sale-approved",
      "status": "pass",
      "required": true,
      "reason": null,
      "matchCount": 1,
      "latestMatch": {
        "id": "txn-abc123",
        "timeCreated": "2024-08-13T14:31:58Z",
        "type": "SALE",
        "status": "CAPTURED",
        "amount": 100,
        "currency": "USD",
        "responseCode": "00"
      }
    },
    {
      "namespacedId": "eu-ecommerce:3ds-sale",
      "status": "pend",
      "required": false,
      "reason": "No matches found",
      "matchCount": 0,
      "latestMatch": null
    }
  ],
  "summary": {
    "total": 2,
    "passed": 1,
    "failed": 0,
    "pending": 1,
    "requiredPassing": 1,
    "requiredTotal": 1
  }
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
          npx @globalpayments/cli init --with-config
          npx @globalpayments/cli run --config .gpcli/config.yaml --timeout 5m --json

      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: certification-results
          path: .gpcli/results/
```

## Authentication & Security

### Credential Handling

- **Never hardcode credentials** — Always use environment variables
- **Config is redacted** — Sensitive keys (`appKey`, `appId`, etc.) are masked in persisted config summaries
- **No transaction submission** — The CLI only reads; it doesn't submit or modify transactions
- **Credentials are never logged** — Auth failures show only error codes, not secrets

### Recommended Practices

- Use a dedicated service account with `transactions:read` scope only
- Rotate credentials regularly
- Store secrets in your CI/CD provider (GitHub Secrets, GitLab CI/CD variables, etc.)
- Run certification observer in a separate environment from your integration

## Troubleshooting

### **Error: `Invalid credentials`**
- **Cause:** App ID or app key is incorrect, expired, or lacks permissions
- **Solution:**
  1. Verify credentials in GP Developer Portal
  2. Confirm the account has API access enabled
  3. Try `gpcli auth test --config .gpcli/config.yaml` to debug

### **Error: `No transactions found`**
- **Cause:** Poll window is too small, or your integration hasn't submitted transactions yet
- **Solution:**
  1. Increase `polling.lookbackMinutes` in config (default: 15)
  2. Ensure your integration is actively submitting test transactions
  3. Check that `accountName` in matcher rules matches your GP account
  4. Run `gpcli doctor` to confirm account access

### **Error: `Ambiguous match` on a case**
- **Cause:** Multiple transactions match with identical timestamp
- **Solution:**
  1. Tighten matcher rules (e.g., add `reference` or `amount` to disambiguate)
  2. Add a custom evaluator to handle tie-breaking logic

### **Watch mode exits after timeout with partial results**
- **Cause:** Timeout reached before all required cases passed
- **Solution:**
  1. Increase `--timeout` (e.g., `--timeout 15m`)
  2. Check transaction submission in your integration (may be too slow)
  3. Review `.gpcli/results/latest.json` to see which cases are pending

### **Port or file permission errors**
- **Cause:** `.gpcli/` directory lacks write permissions, or another process is using the port
- **Solution:**
  1. Ensure `.gpcli/` exists and is writable: `mkdir -p .gpcli && chmod 755 .gpcli`
  2. Check for running gpcli processes: `ps aux | grep gpcli`

### **Matcher rules not matching transactions**
- **Cause:** Matcher fields don't align with actual transaction structure
- **Solution:**
  1. Run `gpcli watch` to see recent transactions in real-time
  2. Compare transaction fields to your matcher criteria
  3. Use `gpcli cases show <caseId>` to review the full case definition
  4. Add debug output to custom evaluators if using script mode

## Programmatic API

Import and use gp-cli as a Node.js module:

```typescript
import { buildCli } from '@globalpayments/cli';
import { loadObserverConfig } from '@globalpayments/cli/config/load';
import { CertificationEngine } from '@globalpayments/cli/core/engine';
import { HttpGpApiClient } from '@globalpayments/cli/gpapi/client';
import { GpApiAuthProvider } from '@globalpayments/cli/gpapi/auth';

async function runCertification() {
  const config = await loadObserverConfig('.gpcli/config.yaml');
  const authProvider = new GpApiAuthProvider();
  const apiClient = new HttpGpApiClient(authProvider);
  const engine = new CertificationEngine(config, apiClient);

  const result = await engine.run({ timeout: 300000 });
  console.log('Pass:', result.summary.passed, 'Fail:', result.summary.failed);
}

runCertification().catch(console.error);
```

See `src/` for full type definitions.

## Testing

Run the test suite:

```bash
npm test              # Single run
npm run test:watch   # Watch mode
```

Coverage includes:
- Config loading and schema validation
- Auth provider and GP API client
- Matcher logic and case evaluation
- Polling state machine and window management
- Result persistence and redaction
- Diagnostics and error messages
- CLI smoke tests

## Development

```bash
npm install
npm run lint          # Type check
npm run build         # Compile to dist/
npm run dev           # Run from source (tsx)
npm test              # Tests

# Try the CLI locally
node dist/bin.js --help
node dist/bin.js doctor --config examples/gpcli.config.yaml
```

## Contributing

Contributions are welcome. Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Run `npm run lint` and `npm test` before submitting PR
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
