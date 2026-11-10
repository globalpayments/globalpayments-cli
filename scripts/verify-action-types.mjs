/**
 * Verify the action types that actions-sourced cases match on.
 *
 * Exercises GP API endpoints in a SANDBOX, records the action type GP logs for each
 * call, and compares it with each case's `matcher.type`. With --apply, cases whose
 * call succeeded (HTTP 2xx) are updated to the observed type and re-tagged
 * `action-type-confirmed`.
 *
 * Safety:
 * - Refuses to run unless GP_API_ENVIRONMENT / GP_ENVIRONMENT is sandbox (or unset).
 * - Real resources are only created for low-value card transactions it owns.
 * - Every other mutating call uses placeholder ids or an empty body, so it is
 *   rejected by GP. A rejected request is still logged, which is how the action type
 *   of an endpoint the app is not permitted to use is learned.
 * - Never sends POST /batches without an id (that would close the open batch).
 * - Credentials and tokens are never printed.
 *
 * Usage:
 *   node scripts/verify-action-types.mjs [--apply] [--all] [--only <address,...>]
 *                                        [--env-file <path>] [--json]
 *
 *   --all    also re-check cases already tagged action-type-confirmed
 *   --only   restrict to these case addresses (e.g. global-payment-actions:reversal)
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKS_DIR = path.join(ROOT, 'src', 'packs');
const API_VERSION = '2021-03-22';
const SANDBOX_URL = 'https://apis.sandbox.globalpay.com/ucp';
const IGNORED_ACTION_TYPES = new Set(['CREATE_TOKEN', 'ACTION_LIST']);
const EVIDENCE_TAGS = ['action-type-confirmed', 'action-type-documented', 'action-type-inferred'];

const PLACEHOLDER_PREFIX = {
  transactions: 'TRN', disputes: 'DIS', merchants: 'MER', orders: 'ORD', funds: 'FND',
  accounts: 'FMA', 'payment-methods': 'PMT', payers: 'PYR', consents: 'CNS',
  authentications: 'AUT', batches: 'BAT', transfers: 'TFR', links: 'LNK',
  deposits: 'DEP', actions: 'ACT', documents: 'DOC'
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Endpoints a case covers, parsed from its name: "… — POST /a or POST /b". */
export function caseEndpoints(name) {
  const match = /— ((?:GET|POST|PATCH|PUT|DELETE) .+)$/.exec(name ?? '');
  return match ? match[1].split(' or ').map((s) => s.trim()) : [];
}

/** Parse a GP timestamp as UTC; some actions (e.g. GET_CHALLENGE_RESULT) omit the zone. */
export function gpTime(value) {
  const zoneless = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(String(value ?? '').trim());
  return zoneless ? Date.parse(`${zoneless[1]}T${zoneless[2]}Z`) : Date.parse(value);
}

export function evidenceOf(tags = []) {
  const tag = tags.find((t) => EVIDENCE_TAGS.includes(t));
  return tag ? tag.replace('action-type-', '') : undefined;
}

/** Replace `{param}` segments with placeholder ids shaped like real GP ids. */
export function placeholderPath(endpointPath) {
  const segments = endpointPath.split('/');
  return segments
    .map((segment, i) => {
      if (!/^\{.+\}$/.test(segment)) return segment;
      const owner = segments[i - 1] ?? '';
      const prefix = PLACEHOLDER_PREFIX[owner] ?? segment.replace(/[{}]/g, '').split('_')[0].toUpperCase().slice(0, 3);
      return `${prefix}_gpcliVerifyPlaceholder0000000`;
    })
    .join('/');
}

/**
 * Pair each recorded call with the action GP logged for it.
 *
 * Calls whose response carried an `action.id` are anchors. They also measure the
 * offset between this machine's clock and GP's. Every other call is paired with the
 * unclaimed logged action closest to the call's midpoint (in GP time), provided it
 * falls inside the call's own time span plus a small tolerance. Calls without a
 * logged action in that span stay unpaired rather than being guessed.
 */
export function reconcile(calls, actions, toleranceMs = 300) {
  const pool = actions.filter((a) => !IGNORED_ACTION_TYPES.has(a.type));
  const byId = new Map(pool.map((a) => [a.id, a]));
  const claimed = new Set();
  const result = new Map();
  const offsets = [];

  for (const call of calls) {
    const anchor = call.responseActionId ? byId.get(call.responseActionId) : undefined;
    if (anchor) {
      claimed.add(anchor.id);
      result.set(call.seq, anchor);
      if (call.tStart !== undefined && call.tEnd !== undefined) {
        offsets.push(gpTime(anchor.time_created) - (call.tStart + call.tEnd) / 2);
      }
    } else if (call.responseActionType) {
      result.set(call.seq, { id: call.responseActionId, type: call.responseActionType, http_response_code: String(call.status) });
    }
  }

  offsets.sort((a, b) => a - b);
  const offset = offsets.length > 0 ? offsets[Math.floor(offsets.length / 2)] : 0;

  for (const call of calls) {
    if (result.has(call.seq) || call.tStart === undefined || call.tEnd === undefined) continue;
    const from = call.tStart + offset - toleranceMs;
    const to = call.tEnd + offset + toleranceMs;
    const mid = (call.tStart + call.tEnd) / 2 + offset;
    let best;
    for (const action of pool) {
      if (claimed.has(action.id)) continue;
      const t = gpTime(action.time_created);
      if (t < from || t > to) continue;
      if (!best || Math.abs(t - mid) < Math.abs(gpTime(best.time_created) - mid)) best = action;
    }
    if (best) {
      claimed.add(best.id);
      result.set(call.seq, best);
    }
  }
  return result;
}

/**
 * Verdict for one case given the action observed for its target call.
 *
 * Only a successful call verifies anything. GP's log for rejected calls is not
 * reliable evidence of the endpoint's action type: in sandbox, `GET /transfers/{id}`
 * rejected with 405 was logged as `AUTHORIZE`, and several 403s were not logged at all.
 */
export function verdictFor(currentType, observed, httpStatus) {
  const ok = httpStatus >= 200 && httpStatus < 300;
  if (!ok) return 'unverified';
  if (!observed) return 'not-logged';
  return observed.type === currentType ? 'confirmed' : 'corrected';
}

/**
 * Rewrite a case YAML to the observed action type, preserving comments.
 * Only called for verdicts backed by a successful (2xx) call.
 *
 * When the observed type is shared with other cases, the case cannot distinguish its
 * endpoint from theirs, so it is downgraded to optional `observability: partial`.
 */
export function applyObservedType(yamlText, observedType, date, sharesTypeWith = []) {
  let text = yamlText;
  const matcherAt = text.search(/^matcher:\s*$/m);
  if (matcherAt === -1) throw new Error('case has no matcher block');
  const head = text.slice(0, matcherAt);
  let tail = text.slice(matcherAt);
  if (/^ {2}type: .*$/m.test(tail)) {
    tail = tail.replace(/^ {2}type: .*$/m, `  type: ${observedType}`);
  } else {
    tail = tail.replace(/^matcher:\s*$/m, `matcher:\n  type: ${observedType}`);
  }
  text = head + tail;
  text = text.replace(/^ {2}- action-type-(inferred|documented)$/m, '  - action-type-confirmed');
  let note = `# Action type confirmed in a GP sandbox action log (scripts/verify-action-types.mjs, ${date}).`;
  if (sharesTypeWith.length > 0) {
    text = text.replace(/^required: true$/m, 'required: false');
    text = text.replace(/^observability: \w+$/m, 'observability: partial');
    note += `\n# GP logs this endpoint as ${observedType}, the same action type as ${sharesTypeWith.join(', ')}, so this case cannot tell them apart.`;
  }
  text = text.replace(
    /^# Action type (inferred from GP naming conventions[^\n]*|taken from GP developer documentation examples\.)$/m,
    note
  );
  return text;
}

// ---------------------------------------------------------------------------
// Case catalog
// ---------------------------------------------------------------------------

function loadActionCases() {
  const cases = [];
  for (const pack of readdirSync(PACKS_DIR)) {
    const dir = path.join(PACKS_DIR, pack, 'cases');
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      const filePath = path.join(dir, file);
      const doc = YAML.parse(readFileSync(filePath, 'utf8'));
      if (doc.source !== 'actions') continue;
      const endpoints = caseEndpoints(doc.name);
      cases.push({
        address: `${pack}:${doc.id}`,
        filePath,
        type: doc.matcher?.type,
        resource: doc.matcher?.resource,
        evidence: evidenceOf(doc.tags),
        endpoint: endpoints.find((e) => e !== 'POST /batches') ?? endpoints[0]
      });
    }
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Sandbox client
// ---------------------------------------------------------------------------

function loadEnv(file) {
  const env = { ...process.env };
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

class SandboxClient {
  constructor(token) {
    this.token = token;
    this.calls = [];
  }

  static async connect(appId, appKey) {
    const nonce = new Date().toISOString();
    const secret = createHash('sha512').update(nonce + appKey).digest('hex');
    const response = await fetch(`${SANDBOX_URL}/accesstoken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GP-Version': API_VERSION },
      body: JSON.stringify({ app_id: appId, nonce, secret, grant_type: 'client_credentials' })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token) {
      throw new Error(`Token request failed (HTTP ${response.status} ${body.error_code ?? ''})`);
    }
    const client = new SandboxClient(body.token);
    client.scope = body.scope ?? {};
    return client;
  }

  async call(method, apiPath, body, label) {
    const seq = this.calls.length;
    const tStart = Date.now();
    const response = await fetch(`${SANDBOX_URL}${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-GP-Version': API_VERSION },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await response.json().catch(() => ({}));
    const tEnd = Date.now();
    this.calls.push({
      seq,
      label: label ?? `${method} ${apiPath}`,
      method,
      path: apiPath,
      status: response.status,
      tStart,
      tEnd,
      responseActionId: json.action?.id,
      responseActionType: json.action?.type,
      error: json.error_code ? `${json.error_code}${json.detailed_error_description ? `: ${json.detailed_error_description}` : ''}` : undefined
    });
    // Space calls so log order matches call order.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { seq, status: response.status, json };
  }

  async actionsSince(fromIso, appId) {
    const all = [];
    for (let page = 1; page <= 10; page += 1) {
      const params = new URLSearchParams({
        page: String(page), page_size: '1000', order: 'DESC', order_by: 'TIME_CREATED',
        from_time_created: fromIso.slice(0, 10)
      });
      const response = await fetch(`${SANDBOX_URL}/actions?${params}`, {
        headers: { Authorization: `Bearer ${this.token}`, 'X-GP-Version': API_VERSION }
      });
      if (!response.ok) throw new Error(`GET /actions failed (HTTP ${response.status})`);
      const batch = (await response.json()).actions ?? [];
      let reachedStart = false;
      for (const action of batch) {
        if (gpTime(action.time_created) < Date.parse(fromIso)) { reachedStart = true; continue; }
        if (action.app_id === appId) all.push(action);
      }
      if (reachedStart || batch.length < 1000) break;
    }
    return all;
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const CARD = { number: '4263970000005262', expiry_month: '12', expiry_year: '30', cvv: '123' };

function accountNamed(scope, prefix, preferred) {
  const accounts = (scope.accounts ?? []).filter((a) => a.id?.startsWith(`${prefix}_`));
  return (accounts.find((a) => a.name === preferred) ?? accounts.find((a) => !/hpp/i.test(a.name)) ?? accounts[0])?.name;
}

function firstId(json, ...keys) {
  for (const key of keys) {
    const list = json?.[key];
    if (Array.isArray(list) && list[0]?.id) return list[0].id;
  }
  return undefined;
}

/**
 * Real flows. Each records the target call for an endpoint key via `hit(endpoint, …)`.
 * Endpoints not exercised here fall back to a placeholder probe.
 */
async function runFlows(client, hits) {
  const tx = accountNamed(client.scope, 'TRA', 'transaction_processing');
  const disputes = accountNamed(client.scope, 'DIA', 'dispute_management');
  const settlement = accountNamed(client.scope, 'DAA', 'settlement_reporting');
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const hit = async (endpoint, method, apiPath, body) => {
    const result = await client.call(method, apiPath, body, endpoint);
    hits.set(endpoint, result.seq);
    return result;
  };
  // A just-created resource can 404 for a few seconds; earlier attempts are setup noise.
  const hitUntilFound = async (endpoint, method, apiPath, attempts = 5) => {
    let result;
    for (let i = 0; i < attempts; i += 1) {
      result = await hit(endpoint, method, apiPath);
      if (result.status !== 404) break;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return result;
  };
  const sale = (amount, captureMode) =>
    client.call('POST', '/transactions', {
      account_name: tx, channel: 'CNP', type: 'SALE', capture_mode: captureMode, amount: String(amount),
      currency: 'USD', reference: `gpcli-verify-${Date.now()}`, country: 'US',
      payment_method: { name: 'GP CLI Verify', entry_mode: 'ECOM', card: CARD }
    }, `setup: sale ${captureMode}`);

  if (tx) {
    const a = await sale(131, 'AUTO');
    const trnA = a.json.id;
    if (trnA) {
      await hit('POST /transactions/{id}/hold', 'POST', `/transactions/${trnA}/hold`, {});
      await hit('POST /transactions/{id}/release', 'POST', `/transactions/${trnA}/release`, {});
      await hit('POST /transactions/{id}/split', 'POST', `/transactions/${trnA}/split`, {});
      await hit('POST /transactions/{id}/challenge', 'POST', `/transactions/${trnA}/challenge`, {});
      await hit('POST /transactions/{id}/refund', 'POST', `/transactions/${trnA}/refund`, { amount: '131' });
      const got = await hitUntilFound('GET /transactions/{id}', 'GET', `/transactions/${trnA}`);
      const batchId = got.json.batch_id;
      if (batchId) {
        await hit('GET /batches/{id}/transactions', 'GET', `/batches/${batchId}/transactions`);
      }
    }

    const b = await sale(132, 'AUTO');
    if (b.json.id) {
      await hit('POST /transactions/{id}/reversal', 'POST', `/transactions/${b.json.id}/reversal`, {});
      await hit('POST /transactions/{id}/reauthorization', 'POST', `/transactions/${b.json.id}/reauthorization`, {});
    }

    const c = await sale(133, 'LATER');
    if (c.json.id) {
      await hit('POST /transactions/{id}/incremental', 'POST', `/transactions/${c.json.id}/incremental`, { amount: '10' });
      await hit('POST /transactions/{id}/capture', 'POST', `/transactions/${c.json.id}/capture`, {});
    }

    const authAmount = '134';
    const authReference = `gpcli-verify-${Date.now()}`;
    const authNotifications = {
      challenge_return_url: 'https://example.com/gpcli-verify/3ds-return',
      three_ds_method_return_url: 'https://example.com/gpcli-verify/3ds-method'
    };
    const authCard = { number: CARD.number, expiry_month: CARD.expiry_month, expiry_year: CARD.expiry_year };
    const avail = await hit('POST /authentications', 'POST', '/authentications', {
      account_name: tx, channel: 'CNP', amount: authAmount, currency: 'USD', country: 'US',
      reference: authReference,
      notifications: authNotifications,
      payment_method: { entry_mode: 'ECOM', card: authCard }
    });
    const list = await client.call('GET', '/authentications?page_size=1', undefined, 'setup: list authentications');
    const authId = avail.json.id ?? firstId(list.json, 'authentications');
    if (authId) {
      await hitUntilFound('GET /authentications/{id}', 'GET', `/authentications/${authId}`);
      // The test card is frictionless, so initiate completes the authentication and
      // /result succeeds. Without initiate, GP rejects /result (server_trans_id not found).
      // A decoupled_notification_url would make GP demand decoupled_flow_request.
      await hit('POST /authentications/{id}/initiate', 'POST', `/authentications/${authId}/initiate`, {
        three_ds: { source: 'BROWSER', preference: 'NO_PREFERENCE' },
        account_name: tx, channel: 'CNP', amount: authAmount, currency: 'USD', country: 'US',
        method_url_completion_status: 'YES',
        merchant_contact_url: 'https://example.com/gpcli-verify/contact',
        order: {
          time_created_reference: new Date().toISOString(),
          amount: authAmount, currency: 'USD', reference: authReference, address_match_indicator: 'false',
          shipping_address: { line1: '1 Test St', city: 'Atlanta', postal_code: '30301', state: 'GA', country: '840' }
        },
        payment_method: { entry_mode: 'ECOM', card: authCard },
        payer: {
          email: 'gpcli-verify@example.com',
          billing_address: { line1: '1 Test St', city: 'Atlanta', postal_code: '30301', state: 'GA', country: '840' }
        },
        browser_data: {
          accept_header: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          color_depth: 'TWENTY_FOUR_BITS', ip: '123.123.123.123', java_enabled: 'false', javascript_enabled: 'true',
          language: 'en-US', screen_height: '1080', screen_width: '1920', challenge_window_size: 'FULL_SCREEN',
          timezone: '0', user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        },
        notifications: authNotifications
      });
      await hit('GET /authentications/{id}/result', 'GET', `/authentications/${authId}/result`);
    }

    const link = await hit('POST /links', 'POST', '/links', {
      account_name: tx, type: 'PAYMENT', usage_mode: 'SINGLE', usage_limit: '1',
      reference: `gpcli-verify-${Date.now()}`, name: 'GP CLI verification link',
      description: 'Created by scripts/verify-action-types.mjs', shippable: 'NO',
      transactions: { amount: '135', currency: 'USD', country: 'US', channel: 'CNP', allowed_payment_methods: ['CARD'] }
    });
    if (link.json.id) await hitUntilFound('GET /links/{id}', 'GET', `/links/${link.json.id}`);
  }

  const accounts = await client.call('GET', '/accounts?page_size=5', undefined, 'setup: list accounts');
  const accountId = firstId(accounts.json, 'accounts', 'data');
  if (accountId) await hit('GET /accounts/{id}', 'GET', `/accounts/${accountId}`);

  if (settlement) {
    const q = `account_name=${encodeURIComponent(settlement)}&from_time_created=${since}&page_size=1`;
    await hit('GET /settlement/reports/monthly-fees', 'GET', `/settlement/reports/monthly-fees?${q}`);
    const deposits = await client.call('GET', `/settlement/deposits?${q}`, undefined, 'setup: list deposits');
    const depositId = firstId(deposits.json, 'deposits');
    if (depositId) await hit('GET /settlement/deposits/{id}', 'GET', `/settlement/deposits/${depositId}?account_name=${encodeURIComponent(settlement)}`);
  }

  if (disputes) {
    const list = await client.call('GET', `/disputes?account_name=${encodeURIComponent(disputes)}&page_size=1`, undefined, 'setup: list disputes');
    const disputeId = firstId(list.json, 'disputes');
    if (disputeId) {
      const got = await hit('GET /disputes/{id}', 'GET', `/disputes/${disputeId}`);
      const docId = got.json.documents?.[0]?.id;
      if (docId) await hit('POST /disputes/{id}/documents/{doc_id}', 'POST', `/disputes/${disputeId}/documents/${docId}`, {});
    }
  }

  const links = await client.call('GET', '/links?page_size=1', undefined, 'setup: list links');
  const linkId = firstId(links.json, 'links');
  if (linkId && !hits.has('GET /links/{id}')) await hit('GET /links/{id}', 'GET', `/links/${linkId}`);

  await hit('POST /payment-methods/search', 'POST', '/payment-methods/search', {
    account_name: accountNamed(client.scope, 'TKA', 'tokenization'),
    card: { number: CARD.number, expiry_month: CARD.expiry_month, expiry_year: CARD.expiry_year }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { apply: false, all: false, json: false, only: undefined, envFile: path.join(ROOT, '.env') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--all') args.all = true;
    else if (a === '--json') args.json = true;
    else if (a === '--only') args.only = new Set(argv[++i].split(',').map((s) => s.trim()));
    else if (a === '--env-file') args.envFile = argv[++i];
    else if (a === '--debug') args.debug = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv(args.envFile);
  const environment = (env.GP_API_ENVIRONMENT ?? env.GP_ENVIRONMENT ?? 'sandbox').toLowerCase();
  if (environment !== 'sandbox') {
    throw new Error(`Refusing to run against '${environment}'. This script only runs in sandbox.`);
  }
  if (!env.GP_API_APP_ID || !env.GP_API_APP_KEY) {
    throw new Error('GP_API_APP_ID and GP_API_APP_KEY must be set (environment or --env-file).');
  }

  const targets = loadActionCases().filter((c) =>
    args.only ? args.only.has(c.address) : args.all || c.evidence !== 'confirmed'
  );
  if (targets.length === 0) throw new Error('No cases selected.');

  const log = (msg) => { if (!args.json) console.error(msg); };
  log(`Verifying ${targets.length} case(s) against the sandbox…`);

  const client = await SandboxClient.connect(env.GP_API_APP_ID, env.GP_API_APP_KEY);
  const startedAt = new Date(Date.now() - 5000).toISOString();
  const hits = new Map();

  await runFlows(client, hits);

  for (const endpoint of new Set(targets.map((t) => t.endpoint).filter(Boolean))) {
    if (hits.has(endpoint)) continue;
    const [method, apiPath] = endpoint.split(' ');
    const result = await client.call(method, placeholderPath(apiPath), method === 'GET' || method === 'DELETE' ? undefined : {}, endpoint);
    hits.set(endpoint, result.seq);
  }

  // Actions can take several seconds to be queryable.
  let observed = new Map();
  let lastActions = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const actions = await client.actionsSince(startedAt, env.GP_API_APP_ID);
    lastActions = actions;
    observed = reconcile(client.calls, actions);
    const unlogged = [...hits.values()].filter((seq) => client.calls[seq].status < 300 && !observed.has(seq)).length;
    log(`  attempt ${attempt + 1}: ${actions.length} action(s) logged, ${unlogged} successful call(s) not yet visible`);
    if (unlogged === 0) break;
  }

  const date = new Date().toISOString().slice(0, 10);
  if (args.debug) {
    const strip = ({ id, type, resource, resource_id, http_response_code, response_code, time_created }) =>
      ({ id, type, resource, resource_id, http_response_code, response_code, time_created });
    writeFileSync(args.debug, JSON.stringify({ calls: client.calls, actions: lastActions.map(strip) }, null, 2));
  }
  const allCases = loadActionCases();
  const results = targets.map((t) => {
    const seq = hits.get(t.endpoint);
    const call = client.calls[seq];
    const action = seq === undefined ? undefined : observed.get(seq);
    const verdict = seq === undefined ? 'not-exercised' : verdictFor(t.type, action, call.status);
    const observedType = action?.type || null;
    const sharesTypeWith =
      verdict === 'corrected'
        ? allCases
            .filter((o) => o.address !== t.address && o.type === observedType && (!t.resource || !o.resource || o.resource === t.resource))
            .map((o) => o.address)
        : [];
    return {
      address: t.address,
      endpoint: t.endpoint,
      evidence: t.evidence,
      caseType: t.type ?? null,
      observedType,
      observedResource: action?.resource ?? null,
      http: call?.status ?? null,
      error: call?.error ?? null,
      verdict,
      sharesTypeWith
    };
  });

  const applied = [];
  if (args.apply) {
    for (const r of results) {
      if (r.verdict !== 'confirmed' && r.verdict !== 'corrected') continue;
      const target = targets.find((t) => t.address === r.address);
      const before = readFileSync(target.filePath, 'utf8');
      const after = applyObservedType(before, r.observedType, date, r.sharesTypeWith);
      if (after !== before) {
        writeFileSync(target.filePath, after);
        applied.push(r.address);
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ results, applied }, null, 2));
    return;
  }

  const order = ['corrected', 'confirmed', 'not-logged', 'unverified', 'not-exercised'];
  results.sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || a.address.localeCompare(b.address));
  for (const r of results) {
    let detail;
    if (r.verdict === 'corrected') detail = `${r.caseType ?? '(none)'} → ${r.observedType}${r.sharesTypeWith.length ? `   (same type as ${r.sharesTypeWith.join(', ')})` : ''}`;
    else if (r.verdict === 'unverified') {
      const target = targets.find((t) => t.address === r.address);
      const hintTrusted = r.observedType && (!target.resource || r.observedResource === target.resource);
      detail = `${r.caseType ?? '(none)'}   [${(r.error ?? 'no detail').slice(0, 90)}]${hintTrusted ? `   logged as ${r.observedType}` : ''}`;
    }
    else detail = r.caseType ?? '(none)';
    console.log(`${r.verdict.padEnd(13)} ${r.address.padEnd(48)} ${String(r.http ?? '-').padEnd(4)} ${detail}`);
  }
  const tally = Object.fromEntries(order.map((v) => [v, results.filter((r) => r.verdict === v).length]));
  console.log(`\n${JSON.stringify(tally)}`);
  console.log('Only successful (2xx) calls verify a type; "logged as" on a rejected call is a hint, not evidence.');
  if (args.apply) console.log(`Updated ${applied.length} case file(s). Run \`npm run verify\` next.`);
  else console.log('Dry run. Re-run with --apply to update cases backed by a successful call.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`verify-action-types: ${error.message}`);
    process.exit(1);
  });
}
