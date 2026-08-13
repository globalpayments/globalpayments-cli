import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunResult } from '../types/domain.js';

export async function persistRunResult(result: RunResult, rootDir = '.gpcli/results'): Promise<{ latestPath: string; historyPath: string }> {
  const historyDir = path.join(rootDir, 'history');
  await mkdir(historyDir, { recursive: true });

  const latestPath = path.join(rootDir, 'latest.json');
  const historyPath = path.join(historyDir, `${result.timestamp}.json`);

  const content = JSON.stringify(result, null, 2);
  await writeFile(latestPath, content, 'utf8');
  await writeFile(historyPath, content, 'utf8');

  return { latestPath, historyPath };
}
