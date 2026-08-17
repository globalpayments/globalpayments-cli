# Global Payments CLI  Quickstart

**Welcome to gp-cli! Here's how to get started in 5 minutes.**

## Installation

```bash
# Clone and install
git clone https://github.com/globalpayments/globalpayments-cli.git
cd gp-cli
npm install

# Build the CLI
npm run build

# You're ready!
node dist/bin.js --help
```

## Set Up Credentials

```bash
# Option 1: Environment variables (recommended for CI/CD)
export GP_API_APP_ID="your-app-id"
export GP_API_APP_KEY="your-app-key"
export GP_API_ENVIRONMENT="sandbox"

# Option 2: Config file
npm run dev -- init
# Follows prompts, creates .gpcli/config.yaml
```

## Test Your Setup

```bash
# Validate credentials and account access
npm run dev -- doctor --config .gpcli/config.yaml

# Expected output:
# ✓ Valid credentials
# ✓ Token expires: 2024-08-13T14:32:45Z
# ✓ Scope: transactions:read
# ✓ Resolved 3 packs (42 total cases)
```

## See Available Test Cases

```bash
npm run dev -- cases list --config .gpcli/config.yaml

# Output:
# Global Core (v1.0.0)
#   ✓ REQUIRED  sale-approved - Sale approved
#   ○ optional  sale-declined - Sale declined
#   ○ optional  sale-reversal - Sale reversal
# ... (more packs)
```

## Run in Watch Mode (Live Feedback)

```bash
npm run dev -- watch --config .gpcli/config.yaml --timeout 10m

# Shows real-time polling:
# Polling (elapsed: 2m 15s | fetched: 234 txns | window: 15m)
# ✓ global-core:sale-approved [PASS]
# ○ eu-ecommerce:3ds-sale [PEND] — Awaiting match
```

## Run in CI Mode (Exit Non-Zero on Fail)

```bash
npm run dev -- run --config .gpcli/config.yaml --timeout 5m --json

# Exits 0 if all required cases pass
# Exits 1 if any required case fails
# Outputs JSON for CI/CD pipelines
```

## View Results

```bash
npm run dev -- report --input .gpcli/results/latest.json

# Pretty-prints results:
# ✓ PASS: global-core:sale-approved
# ✗ FAIL: eu-ecommerce:3ds-sale — No matches found
# Summary: 1/2 required cases passing
```

## Useful Commands

| Command | Purpose |
|---------|---------|
| `npm run lint` | Type-check code |
| `npm test` | Run test suite |
| `npm run dev -- --help` | CLI help |
| `npm run dev -- cases show global-core:sale-approved` | Show full case details |
| `npm run dev -- auth test` | Quick auth validation |

## Common Issues

### Error: "Invalid credentials"
```bash
# Check your credentials
echo $GP_API_APP_ID
echo $GP_API_APP_KEY

# Re-run doctor to debug
npm run dev -- doctor
```

### Error: "No transactions found"
```bash
# 1. Increase lookback window in config
# polling:
#   lookbackMinutes: 30  # (default: 15)

# 2. Make sure your integration is submitting test transactions
# 3. Check that you're using the right account name
```

### Port or permission errors
```bash
# Ensure .gpcli/ directory exists and is writable
mkdir -p .gpcli
chmod 755 .gpcli

# Check for running processes
ps aux | grep gpcli
```

## Next Steps

1. **Read the full README** — Covers all commands, config options, and case definitions
   ```bash
   cat README.md
   ```

2. **Review CONTRIBUTING.md** — If you plan to add cases or modify the tool
   ```bash
   cat CONTRIBUTING.md
   ```

3. **Check PREP-SUMMARY.md** — For detailed technical info
   ```bash
   cat PREP-SUMMARY.md
   ```

4. **Try all CLI commands** — Get familiar with the full tool
   ```bash
   npm run dev -- cases list --pack global-core
   npm run dev -- cases show global-core:sale-approved
   ```

5. **Integrate into your CI/CD** — Run gpcli automatically on every deploy
   ```yaml
   # Example: GitHub Actions
   - name: Validate certification
     run: npx @globalpayments/cli run --config .gpcli/config.yaml --timeout 5m
   ```

## Questions?

- Read README.md (detailed guide)
- Check CONTRIBUTING.md (for contributing)
- Ask your team lead
- Review examples in `examples/gpcli.config.yaml`

---

**You're ready!** Start with `npm run dev -- doctor` and go from there.
