import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { persistRunResult } from '../src/core/result-store.js';
import type { RunResult } from '../src/types/domain.js';

describe('results', () => {
  it('persists latest and timestamped history artifacts', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'globalpayments-results-'));
    const result: RunResult = {
      schemaVersion: 1,
      timestamp: '2026-06-18T12-00-00.000Z',
      environment: 'sandbox',
      activePacks: ['global-core'],
      verdict: 'passed',
      summary: { pass: 1, fail: 0, pending: 0, total: 1 },
      required: { total: 1, passing: 1, failing: 0 },
      cases: [
        {
          namespacedCaseId: 'global-core:sale-approved',
          packId: 'global-core',
          caseId: 'sale-approved',
          status: 'pass',
          reason: 'ok',
          matchedCount: 1
        }
      ],
      redactedConfig: { environment: 'sandbox' }
    };

    const paths = await persistRunResult(result, rootDir);

    const latestRaw = await readFile(paths.latestPath, 'utf8');
    const historyRaw = await readFile(paths.historyPath, 'utf8');

    expect(JSON.parse(latestRaw)).toEqual(result);
    expect(JSON.parse(historyRaw)).toEqual(result);
    expect(paths.historyPath).toContain(path.join('history', `${result.timestamp}.json`));
  });

  it('writes history for a real ISO timestamp, whose colons Windows forbids', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'globalpayments-results-'));
    const result = {
      schemaVersion: 1,
      timestamp: '2026-10-28T14:08:32.932Z',
      environment: 'sandbox',
      activePacks: [],
      verdict: 'passed',
      summary: { pass: 0, fail: 0, pending: 0, total: 0 },
      required: { total: 0, passing: 0, failing: 0 },
      cases: [],
      redactedConfig: {}
    } as RunResult;

    const paths = await persistRunResult(result, rootDir);

    expect(path.basename(paths.historyPath)).toBe('2026-10-28T14-08-32.932Z.json');
    expect(JSON.parse(await readFile(paths.historyPath, 'utf8'))).toEqual(result);
  });
});
