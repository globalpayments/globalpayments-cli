#!/usr/bin/env tsx
/**
 * csv-to-cases.ts
 *
 * Build-time utility for the globalpayments-cli maintenance team.
 * Converts a cert-test CSV into YAML case files inside a bundled pack directory.
 *
 * Usage:
 *   npx tsx scripts/csv-to-cases.ts \
 *     --csv path/to/cert-tests.csv \
 *     --pack us-ecomm \
 *     [--cases-dir src/packs/<pack>/cases]
 *     [--dry-run]
 *
 * CSV format (header row required):
 *   id,name,required,type,channel,currency,amount,cardBrand,last4,
 *   referencePrefix,statusIn,responseCodeIn,tags,mode
 *
 * - required: "true"/"false" (default true)
 * - amount: numeric string or empty
 * - statusIn / responseCodeIn: pipe-separated list  e.g. "CAPTURED|PENDING"
 * - tags: pipe-separated list  e.g. "smoke|ecomm"
 * - mode: latest | sequence | aggregate (default "latest")
 * - referencePrefix: optional; if supplied, matcher uses reference-prefix strategy
 */

import { createReadStream } from 'node:fs';
import { mkdir, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// Minimal arg parser (no external deps at script level)
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// CSV parser (single-pass, no dep)
// ---------------------------------------------------------------------------
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

async function readCsv(csvPath: string): Promise<Array<Record<string, string>>> {
  return new Promise((resolve, reject) => {
    const rows: Array<Record<string, string>> = [];
    let headers: string[] = [];

    const rl = readline.createInterface({
      input: createReadStream(csvPath),
      crlfDelay: Infinity
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const fields = parseCsvLine(trimmed);
      if (headers.length === 0) {
        headers = fields.map((h) => h.toLowerCase());
        return;
      }
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = fields[i] ?? '';
      });
      rows.push(row);
    });

    rl.on('close', () => resolve(rows));
    rl.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// YAML serialiser (simple, no dep)
// ---------------------------------------------------------------------------
function yamlStr(value: string): string {
  if (value === '') return "''";
  if (/[:{}\[\],&*#?|<>=!%@`]/.test(value) || value.includes('\n') || value.startsWith(' ') || value.endsWith(' ')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function buildCaseYaml(row: Record<string, string>): string {
  const id = row['id']?.trim();
  const name = row['name']?.trim() || id;
  const required = row['required']?.trim().toLowerCase() !== 'false';
  const type = row['type']?.trim();
  const channel = row['channel']?.trim();
  const currency = row['currency']?.trim();
  const amount = row['amount']?.trim();
  const cardBrand = row['cardbrand']?.trim() || row['card_brand']?.trim();
  const last4 = row['last4']?.trim();
  const referencePrefix = row['referenceprefix']?.trim() || row['reference_prefix']?.trim();
  const mode = (row['mode']?.trim() || 'latest') as 'latest' | 'sequence' | 'aggregate';
  const statusIn = row['statusin']?.trim() || row['status_in']?.trim();
  const responseCodeIn = row['responsecodein']?.trim() || row['response_code_in']?.trim();
  const tags = row['tags']?.trim();

  if (!id) throw new Error(`Row is missing required "id" field: ${JSON.stringify(row)}`);

  const lines: string[] = [];
  lines.push(`id: ${yamlStr(id)}`);
  lines.push(`name: ${yamlStr(name)}`);
  lines.push(`required: ${required}`);

  if (tags) {
    const tagList = tags.split('|').map((t) => t.trim()).filter(Boolean);
    lines.push('tags:');
    tagList.forEach((t) => lines.push(`  - ${yamlStr(t)}`));
  }

  lines.push(`mode: ${mode}`);
  lines.push('matcher:');
  if (referencePrefix) lines.push(`  referencePrefix: ${yamlStr(referencePrefix)}`);
  if (type) lines.push(`  type: ${yamlStr(type)}`);
  if (channel) lines.push(`  channel: ${yamlStr(channel)}`);
  if (currency) lines.push(`  currency: ${yamlStr(currency)}`);
  if (amount) lines.push(`  amount: ${Number(amount)}`);
  if (cardBrand) lines.push(`  cardBrand: ${yamlStr(cardBrand)}`);
  if (last4) lines.push(`  last4: ${yamlStr(last4)}`);

  lines.push('expect:');
  if (mode === 'latest') {
    lines.push('  latest:');
    if (statusIn) {
      const list = statusIn.split('|').map((s) => s.trim()).filter(Boolean);
      lines.push('    statusIn:');
      list.forEach((s) => lines.push(`      - ${yamlStr(s)}`));
    }
    if (responseCodeIn) {
      const list = responseCodeIn.split('|').map((s) => s.trim()).filter(Boolean);
      lines.push('    responseCodeIn:');
      list.forEach((s) => lines.push(`      - ${yamlStr(s)}`));
    }
  }

  lines.push('evaluator:');
  lines.push('  type: declarative');

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  const csvPath = args['csv'] as string | undefined;
  const packId = args['pack'] as string | undefined;
  const dryRun = Boolean(args['dry-run']);

  if (!csvPath || !packId) {
    console.error('Usage: tsx scripts/csv-to-cases.ts --csv <path> --pack <packId> [--dry-run]');
    process.exit(1);
  }

  const defaultCasesDir = path.join('src', 'packs', packId, 'cases');
  const casesDir = (args['cases-dir'] as string | undefined) ?? defaultCasesDir;

  console.log(`Reading CSV: ${csvPath}`);
  const rows = await readCsv(csvPath);
  console.log(`  ${rows.length} case(s) found`);

  if (!dryRun) {
    await mkdir(casesDir, { recursive: true });

    // Remove existing generated YAML files so stale cases don't accumulate
    const existing = await readdir(casesDir).catch(() => [] as string[]);
    const stale = existing.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const f of stale) {
      await unlink(path.join(casesDir, f));
    }
    console.log(`  Cleared ${stale.length} existing case file(s) from ${casesDir}`);
  }

  let written = 0;
  for (const row of rows) {
    const id = row['id']?.trim();
    if (!id) continue;

    const yaml = buildCaseYaml(row);
    const outPath = path.join(casesDir, `${id}.yaml`);

    if (dryRun) {
      console.log(`\n--- ${outPath} ---\n${yaml}`);
    } else {
      await writeFile(outPath, yaml, 'utf8');
      console.log(`  wrote ${outPath}`);
      written++;
    }
  }

  if (!dryRun) {
    console.log(`\nDone. Wrote ${written} case file(s) to ${casesDir}`);
    console.log('Rebuild the package (npm run build) to bundle the updated cases.');
  }
}

main().catch((err) => {
  console.error('csv-to-cases failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
