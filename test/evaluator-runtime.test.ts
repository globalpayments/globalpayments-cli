import { describe, expect, it } from 'vitest';
import { loadEvaluatorModule, loadPackEvaluators, resolveEvaluatorPath } from '../src/core/evaluator-runtime.js';
import type { CertificationPack } from '../src/types/domain.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testFixturesDir = path.join(__dirname, 'fixtures');

describe('evaluator-runtime', () => {
  describe('resolveEvaluatorPath', () => {
    it('resolves a relative script path to absolute', () => {
      const packDir = '/some/pack/dir';
      const scriptName = 'evaluators/default.js';
      const result = resolveEvaluatorPath(packDir, scriptName);
      expect(result).toBe(path.resolve(packDir, scriptName));
    });
  });

  describe('loadEvaluatorModule', () => {
    it('loads a valid evaluator module', async () => {
      const scriptPath = path.join(testFixturesDir, 'evaluators', 'valid-evaluator.mjs');
      const evaluator = await loadEvaluatorModule(scriptPath);

      expect(typeof evaluator).toBe('function');

      // Test the evaluator can be called
      const result = evaluator(undefined, {
        id: 'test',
        name: 'Test',
        required: true,
        matcher: {},
        expect: {}
      });

      expect(result.status).toBe('pass');
    });

    it('throws when module exports are not a function', async () => {
      const scriptPath = path.join(testFixturesDir, 'evaluators', 'invalid-evaluator.mjs');

      await expect(loadEvaluatorModule(scriptPath)).rejects.toThrow(/does not export a function/);
    });

    it('throws when file does not exist', async () => {
      const scriptPath = path.join(testFixturesDir, 'evaluators', 'nonexistent.mjs');

      await expect(loadEvaluatorModule(scriptPath)).rejects.toThrow();
    });
  });

  describe('loadPackEvaluators', () => {
    it('loads all evaluators referenced by a pack', async () => {
      const pack: CertificationPack = {
        id: 'test-pack',
        name: 'Test Pack',
        version: '1.0.0',
        casesDirectory: 'cases',
        cases: [
          {
            id: 'case1',
            name: 'Case 1',
            required: true,
            matcher: {},
            expect: {},
            evaluator: { type: 'script', script: 'evaluators/valid-evaluator.mjs' }
          },
          {
            id: 'case2',
            name: 'Case 2',
            required: false,
            matcher: {},
            expect: {},
            evaluator: { type: 'script', script: 'evaluators/valid-evaluator.mjs' }
          }
        ],
        evaluators: {
          default: 'evaluators/valid-evaluator.mjs'
        }
      };

      const result = await loadPackEvaluators(testFixturesDir, pack);

      expect(Object.keys(result.modules)).toContain('evaluators/valid-evaluator.mjs');
      expect(result.errors).toHaveLength(0);
      expect(typeof result.modules['evaluators/valid-evaluator.mjs']).toBe('function');
    });

    it('collects load errors for missing evaluators', async () => {
      const pack: CertificationPack = {
        id: 'test-pack',
        name: 'Test Pack',
        version: '1.0.0',
        casesDirectory: 'cases',
        cases: [
          {
            id: 'case1',
            name: 'Case 1',
            required: true,
            matcher: {},
            expect: {},
            evaluator: { type: 'script', script: 'evaluators/nonexistent.mjs' }
          }
        ]
      };

      const result = await loadPackEvaluators(testFixturesDir, pack);

      expect(result.errors).toHaveLength(1);
      const err = result.errors[0]!;
      expect(err.type).toBe('load-failure');
      expect(err.scriptPath).toBe('evaluators/nonexistent.mjs');
      expect(err.originalError).toBeInstanceOf(Error);
    });

    it('handles pack evaluator overrides', async () => {
      const pack: CertificationPack = {
        id: 'test-pack',
        name: 'Test Pack',
        version: '1.0.0',
        casesDirectory: 'cases',
        cases: [
          {
            id: 'case1',
            name: 'Case 1',
            required: true,
            matcher: {},
            expect: {}
          }
        ],
        evaluators: {
          default: 'evaluators/valid-evaluator.mjs',
          overrides: {
            case1: 'evaluators/valid-evaluator.mjs'
          }
        }
      };

      const result = await loadPackEvaluators(testFixturesDir, pack);

      // Should have loaded the evaluator (both paths refer to the same file, so one entry)
      expect(Object.keys(result.modules).length).toBeGreaterThan(0);
      expect(result.errors).toHaveLength(0);
    });

    it('gracefully handles mixed valid and invalid evaluators', async () => {
      const pack: CertificationPack = {
        id: 'test-pack',
        name: 'Test Pack',
        version: '1.0.0',
        casesDirectory: 'cases',
        cases: [
          {
            id: 'case1',
            name: 'Case 1',
            required: true,
            matcher: {},
            expect: {},
            evaluator: { type: 'script', script: 'evaluators/valid-evaluator.mjs' }
          },
          {
            id: 'case2',
            name: 'Case 2',
            required: true,
            matcher: {},
            expect: {},
            evaluator: { type: 'script', script: 'evaluators/missing.mjs' }
          }
        ]
      };

      const result = await loadPackEvaluators(testFixturesDir, pack);

      expect(Object.keys(result.modules)).toContain('evaluators/valid-evaluator.mjs');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.scriptPath).toBe('evaluators/missing.mjs');
    });
  });
});
