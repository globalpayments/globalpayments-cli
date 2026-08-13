import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CertificationPack, EvaluatorModule } from '../types/domain.js';

export interface ScriptLoadError {
  type: 'load-failure';
  scriptPath: string;
  originalError: Error;
}

export interface EvaluatorLoadResult {
  modules: Record<string, EvaluatorModule>;
  errors: ScriptLoadError[];
}

/**
 * Validate that a resolved path is within the pack directory (prevents directory traversal).
 */
function validatePackPath(packDir: string, resolvedPath: string): void {
  const relative = path.relative(packDir, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Script path traversal detected: ${resolvedPath} is outside pack directory ${packDir}`
    );
  }
}

/**
 * Resolve an evaluator script path relative to the pack directory.
 * Paths are expected to be relative to the pack root (where pack.yaml lives).
 */
export function resolveEvaluatorPath(packDir: string, scriptName: string): string {
  const resolved = path.resolve(packDir, scriptName);
  validatePackPath(packDir, resolved);
  return resolved;
}

/**
 * Load a single evaluator module from a file.
 * Supports both .js/.ts files (via dynamic import).
 * The module may have a default export or a named export (inspected at load time).
 */
export async function loadEvaluatorModule(scriptPath: string): Promise<EvaluatorModule> {
  try {
    const fileUrl = pathToFileURL(scriptPath).href;
    const module = (await import(fileUrl)) as Record<string, unknown>;

    // Support both default and named export; prefer default.
    const evaluator = module.default || module.evaluator;

    if (typeof evaluator !== 'function') {
      throw new Error(`Evaluator module at ${scriptPath} does not export a function (default or named 'evaluator')`);
    }

    return evaluator as EvaluatorModule;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    throw error;
  }
}

/**
 * Load all evaluators referenced by a pack.
 * Returns both successfully loaded modules and any load errors.
 * Errors are collected and returned separately so that partial load failures don't halt evaluation.
 */
export async function loadPackEvaluators(packDir: string, pack: CertificationPack): Promise<EvaluatorLoadResult> {
  const modules: Record<string, EvaluatorModule> = {};
  const errors: ScriptLoadError[] = [];

  const evaluatorNames = new Set<string>();

  // Collect all evaluator names referenced by the pack
  if (pack.evaluators?.default) {
    evaluatorNames.add(pack.evaluators.default);
  }

  if (pack.evaluators?.overrides) {
    for (const scriptName of Object.values(pack.evaluators.overrides)) {
      evaluatorNames.add(scriptName);
    }
  }

  for (const caze of pack.cases) {
    if (caze.evaluator?.type === 'script' && caze.evaluator.script) {
      evaluatorNames.add(caze.evaluator.script);
    }
  }

  // Load each evaluator once
  for (const scriptName of evaluatorNames) {
    try {
      const scriptPath = resolveEvaluatorPath(packDir, scriptName);
      const evaluator = await loadEvaluatorModule(scriptPath);
      modules[scriptName] = evaluator;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push({
        type: 'load-failure',
        scriptPath: scriptName,
        originalError: error
      });
    }
  }

  return { modules, errors };
}
