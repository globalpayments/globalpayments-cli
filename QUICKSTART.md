# Global Payments CLI — Quickstart

**Get from a fresh clone to a certification result in five minutes.**

## Install

```bash
# Clone and install
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
gpcli readiness

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

3. **Try all CLI commands** — Get familiar with the full tool
   ```bash
   npm run dev -- cases list --pack global-core
   npm run dev -- cases show global-core:sale-approved
   ```

4. **Integrate into your CI/CD** — Run globalpayments automatically on every deploy
   ```yaml
   - name: Validate certification
     run: npx @globalpayments/cli run --cert global-core --timeout 5m --json
   ```

---

**You're ready.** Start with `npm run dev -- doctor` and go from there.
