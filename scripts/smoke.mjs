#!/usr/bin/env node
/**
 * Post-build contract smoke test.
 *
 * The unit suite runs in-source, so it cannot see faults that only exist in the
 * bundled artifact — packaging, path anchoring, and stdout purity among them.
 * This script exercises `dist/bin.js` as a real caller would and asserts the
 * envelope contract holds end to end. It performs no network calls, so it is
 * safe to run in CI without credentials.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'dist', 'bin.js');

const failures = [];
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (!condition) {
    failures.push(detail ? `${label}\n      ${detail}` : label);
  }
}

function invoke(args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    cwd: root,
    // Keep the environment credential-free so no smoke check can reach the network.
    env: { ...process.env, GP_API_APP_ID: '', GP_API_APP_KEY: '' }
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? -1 };
}

function invokeJson(args, label) {
  const result = invoke([...args, '--json']);
  check(`${label}: stderr is empty in --json mode`, result.stderr === '', JSON.stringify(result.stderr.slice(0, 300)));

  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    check(`${label}: stdout is exactly one JSON document`, false, JSON.stringify(result.stdout.slice(0, 300)));
    return null;
  }

  check(`${label}: envelope carries ok/exitCode/command`, typeof envelope.ok === 'boolean' && typeof envelope.exitCode === 'number' && typeof envelope.command === 'string');
  check(`${label}: ok agrees with exitCode`, envelope.ok === (envelope.exitCode === 0), `ok=${envelope.ok} exitCode=${envelope.exitCode}`);
  check(`${label}: process exit matches envelope.exitCode`, result.exitCode === envelope.exitCode, `process=${result.exitCode} envelope=${envelope.exitCode}`);
  check(`${label}: failure implies an error code`, envelope.ok || typeof envelope.error?.code === 'string');

  return envelope;
}

if (!existsSync(bin)) {
  console.error(`smoke: ${bin} not found. Run \`npm run build\` first.`);
  process.exit(1);
}

// --- explain: the manifest must describe the real command tree -------------
const explain = invokeJson(['explain'], 'explain');
check('explain: succeeds', explain?.ok === true);
check('explain: reports commands', Array.isArray(explain?.data?.commands) && explain.data.commands.length > 0);
check('explain: reports exit codes', Array.isArray(explain?.data?.exitCodes) && explain.data.exitCodes.length > 0);
check('explain: reports error codes', Array.isArray(explain?.data?.errorCodes) && explain.data.errorCodes.length > 0);
check(
  'explain: every command supports --json',
  (explain?.data?.commands ?? []).every((command) => command.supportsJson === true),
  (explain?.data?.commands ?? []).filter((c) => !c.supportsJson).map((c) => c.id).join(', ')
);

// --- packs: the bundled suites must survive bundling -----------------------
// This is the check that catches a packs directory anchored to the wrong path
// in dist/, which no in-source unit test can observe.
const packs = invokeJson(['packs', 'list'], 'packs list');
check('packs list: succeeds', packs?.ok === true);
check(
  'packs list: bundled suites are present in the built artifact',
  (packs?.data?.packs ?? []).length > 0,
  `bundledPacksDirectory=${packs?.data?.bundledPacksDirectory}`
);

const packIds = (packs?.data?.packs ?? []).map((pack) => pack.packId);
check('packs list: includes global-core', packIds.includes('global-core'), packIds.join(', '));

// --- cases: addresses are canonical and never double-namespaced ------------
const cases = invokeJson(['cases', 'list', '--cert', 'global-core'], 'cases list');
check('cases list: succeeds', cases?.ok === true);
const addresses = (cases?.data?.cases ?? []).map((entry) => entry.address);
check('cases list: returns at least one case', addresses.length > 0);
check(
  'cases list: every address is exactly <packId>:<caseId>',
  addresses.every((address) => /^[^:]+:[^:]+$/.test(address)),
  addresses.join(', ')
);

// --- error paths: stable codes and distinct exit codes ---------------------
const unknownPack = invokeJson(['cases', 'list', '--cert', 'definitely-not-a-pack'], 'cases list (unknown pack)');
check('unknown pack: exits 6', unknownPack?.exitCode === 6, `got ${unknownPack?.exitCode}`);
check('unknown pack: E_PACK_NOT_FOUND', unknownPack?.error?.code === 'E_PACK_NOT_FOUND', unknownPack?.error?.code);
check('unknown pack: carries remediation', typeof unknownPack?.error?.remediation === 'string');

const missingConfig = invokeJson(['doctor', '--config', 'no/such/config.yaml'], 'doctor (missing config)');
check('missing config: exits 3', missingConfig?.exitCode === 3, `got ${missingConfig?.exitCode}`);

const badFlag = invoke(['run', '--not-a-real-flag']);
check('unknown flag: exits 2', badFlag.exitCode === 2, `got ${badFlag.exitCode}`);

// --- text mode still works -------------------------------------------------
const textPacks = invoke(['packs', 'list']);
check('packs list (text): exits 0', textPacks.exitCode === 0);
check('packs list (text): prints something', textPacks.stdout.trim().length > 0);

// --- report ----------------------------------------------------------------
const missingResult = invokeJson(['report', '--input', 'no/such/result.json'], 'report (missing input)');
check('missing result: exits 6', missingResult?.exitCode === 6, `got ${missingResult?.exitCode}`);

// --- diagnose --------------------------------------------------------------
// The remediation path must work offline, from an artifact alone. Exercised here
// because an agent's red-to-green loop depends on `data.fixPlan` being present in
// the built artifact, not just in source.
const missingDiagnoseResult = invokeJson(['diagnose', '--input', 'no/such/result.json'], 'diagnose (missing input)');
check('diagnose (missing input): exits 6', missingDiagnoseResult?.exitCode === 6, `got ${missingDiagnoseResult?.exitCode}`);
check(
  'diagnose (missing input): E_RESULT_NOT_FOUND',
  missingDiagnoseResult?.error?.code === 'E_RESULT_NOT_FOUND',
  missingDiagnoseResult?.error?.code
);

const badAddress = invokeJson(['diagnose', 'not-an-address', '--input', 'no/such/result.json'], 'diagnose (bad address)');
check('diagnose (bad address): exits 2', badAddress?.exitCode === 2, `got ${badAddress?.exitCode}`);
check('diagnose (bad address): E_USAGE', badAddress?.error?.code === 'E_USAGE', badAddress?.error?.code);

const fixtureDir = mkdtempSync(path.join(tmpdir(), 'globalpayments-smoke-'));
const fixturePath = path.join(fixtureDir, 'result.json');

try {
  writeFileSync(
    fixturePath,
    JSON.stringify({
      schemaVersion: explain?.data?.resultSchemaVersion ?? 2,
      timestamp: '2026-09-14T12:00:00.000Z',
      environment: 'sandbox',
      activePacks: ['global-core'],
      verdict: 'failed',
      summary: { pass: 0, fail: 0, pending: 1, total: 1 },
      required: { total: 1, passing: 0, failing: 1 },
      cases: [
        {
          namespacedCaseId: 'global-core:basic-sale-approved',
          packId: 'global-core',
          caseId: 'basic-sale-approved',
          status: 'pending',
          reason: 'No matching transactions found in current window',
          matchedCount: 0,
          diagnosis: {
            code: 'MATCHER_MISMATCH',
            summary: 'The closest observed transaction used a different amount.',
            observed: { transactionsInWindow: 1, candidatesMatched: 0 },
            fixes: [
              {
                action: 'change-request-field',
                field: 'amount',
                currentValue: 1000,
                requiredValue: 2002,
                instruction: 'Set `amount` to 2002 in the request you send.',
                confidence: 'high'
              }
            ],
            nearMisses: [],
            expectationDeltas: [],
            requiredRequest: { send: { type: 'SALE', amount: 2002 }, mustResultIn: { statusIn: ['CAPTURED'] }, notes: [] }
          }
        }
      ],
      redactedConfig: {}
    }),
    'utf8'
  );

  const diagnose = invokeJson(['diagnose', '--input', fixturePath], 'diagnose');
  check('diagnose: succeeds', diagnose?.ok === true, diagnose?.error?.code);
  check('diagnose: exits 0 even though the run failed', diagnose?.exitCode === 0, `got ${diagnose?.exitCode}`);
  check('diagnose: emits a fix plan', (diagnose?.data?.fixPlan ?? []).length > 0);
  check(
    'diagnose: fix plan entries carry a structured field change',
    diagnose?.data?.fixPlan?.[0]?.field === 'amount' && diagnose?.data?.fixPlan?.[0]?.requiredValue === 2002,
    JSON.stringify(diagnose?.data?.fixPlan?.[0])
  );
  check('diagnose: counts causes by code', diagnose?.data?.byCode?.MATCHER_MISMATCH === 1, JSON.stringify(diagnose?.data?.byCode));

  const scoped = invokeJson(
    ['diagnose', 'global-core:basic-sale-approved', '--input', fixturePath],
    'diagnose (single case)'
  );
  check('diagnose (single case): succeeds', scoped?.ok === true, scoped?.error?.code);
  check('diagnose (single case): returns exactly that case', (scoped?.data?.cases ?? []).length === 1);

  const unknownCase = invokeJson(['diagnose', 'global-core:nope', '--input', fixturePath], 'diagnose (unknown case)');
  check('diagnose (unknown case): exits 6', unknownCase?.exitCode === 6, `got ${unknownCase?.exitCode}`);
  check('diagnose (unknown case): E_CASE_NOT_FOUND', unknownCase?.error?.code === 'E_CASE_NOT_FOUND', unknownCase?.error?.code);

  const diagnoseText = invoke(['diagnose', '--input', fixturePath]);
  check('diagnose (text): exits 0', diagnoseText.exitCode === 0, `got ${diagnoseText.exitCode}`);
  check('diagnose (text): states the fix', diagnoseText.stdout.includes('2002'), diagnoseText.stdout.slice(0, 200));
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nsmoke: ${failures.length} of ${checks} checks failed\n`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  console.error('');
  process.exit(1);
}

console.log(`smoke: ${checks} checks passed against ${path.relative(root, bin)}`);
