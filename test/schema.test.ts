import { describe, expect, it } from 'vitest';
import { caseSchema, observerConfigSchema, packSchema } from '../src/config/schema.js';

describe('schema validation', () => {
  it('validates observer config required fields', () => {
    const result = observerConfigSchema.safeParse({
      version: 1,
      environment: 'sandbox',
      auth: {
        mode: 'app-credentials',
        appId: 'app-id',
        appKey: 'app-key',
        apiVersion: '2021-03-22'
      },
      account: {
        accountName: 'merchant-account'
      },
      polling: {
        intervalMs: 5000,
        lookbackMinutes: 15,
        overlapSeconds: 10,
        pageSize: 100,
        order: 'DESC'
      },
      matching: {
        defaultStrategy: 'reference',
        requireReference: true,
        timeSkewSeconds: 30
      },
      output: {
        format: 'table',
        saveJson: true,
        saveJUnit: false
      },
      packs: {
        directory: './packs'
      }
    });

    expect(result.success).toBe(true);
  });

  it('validates pack and case schemas and rejects invalid fields', () => {
    const packResult = packSchema.safeParse({
      id: 'global-core',
      name: 'Global Core',
      version: '1.0.0',
      cases: {
        directory: 'cases'
      }
    });

    const caseResult = caseSchema.safeParse({
      id: 'sale-approved',
      name: 'Sale approved',
      required: true,
      matcher: {
        referencePrefix: 'cert-sale-'
      },
      expect: {
        latest: {
          statusIn: ['CAPTURED']
        }
      },
      evaluator: {
        type: 'script',
        script: 'scripts/evaluators/sale.js',
        export: 'evaluate'
      }
    });

    const invalidCaseResult = caseSchema.safeParse({
      id: 'bad-case',
      required: true,
      matcher: {},
      expect: {}
    });

    expect(packResult.success).toBe(true);
    expect(caseResult.success).toBe(true);
    expect(invalidCaseResult.success).toBe(false);
  });
});
