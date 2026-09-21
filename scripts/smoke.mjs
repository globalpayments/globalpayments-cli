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
import { existsSync } from 'node:fs';
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

if (failures.length > 0) {
  console.error(`\nsmoke: ${failures.length} of ${checks} checks failed\n`);
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  console.error('');
  process.exit(1);
}

console.log(`smoke: ${checks} checks passed against ${path.relative(root, bin)}`);
