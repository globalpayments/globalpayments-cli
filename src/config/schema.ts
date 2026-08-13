import { z } from 'zod';

export const profileSchema = z.object({
  packs: z.array(z.string()).min(1)
});

export const authConfigSchema = z.object({
  mode: z.literal('app-credentials'),
  appId: z.string().min(1),
  appKey: z.string().min(1),
  apiVersion: z.string().min(1).default('2021-03-22')
});

export const pollingConfigSchema = z.object({
  intervalMs: z.number().int().positive().default(3000),
  lookbackMinutes: z.number().int().positive().default(10),
  overlapSeconds: z.number().int().nonnegative().default(30),
  pageSize: z.number().int().positive().default(100),
  order: z.enum(['ASC', 'DESC']).default('DESC')
});

export const matchingConfigSchema = z.object({
  defaultStrategy: z.string().min(1).default('composite'),
  requireReference: z.boolean().default(false),
  timeSkewSeconds: z.number().int().nonnegative().default(60)
});

export const outputConfigSchema = z.object({
  format: z.string().min(1).default('terminal'),
  saveJson: z.boolean().default(true),
  saveJUnit: z.boolean().default(false)
});

export const observerConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
  auth: authConfigSchema,
  account: z.object({
    accountName: z.string().optional()
  }).default({}),
  polling: pollingConfigSchema.default({
    intervalMs: 3000,
    lookbackMinutes: 10,
    overlapSeconds: 30,
    pageSize: 100,
    order: 'DESC'
  }),
  matching: matchingConfigSchema.default({
    defaultStrategy: 'composite',
    requireReference: false,
    timeSkewSeconds: 60
  }),
  output: outputConfigSchema.default({
    format: 'terminal',
    saveJson: true,
    saveJUnit: false
  }),
  packs: z.object({
    directory: z.string().optional()
  }).default({}),
  activePacks: z.array(z.string()).optional(),
  profiles: z.record(z.string(), profileSchema).optional(),
  activeProfile: z.string().optional()
});

export const caseMatcherSchema = z.object({
  reference: z.string().optional(),
  referencePrefix: z.string().optional(),
  type: z.string().optional(),
  channel: z.string().optional(),
  currency: z.string().optional(),
  amount: z.number().optional(),
  accountName: z.string().optional(),
  cardBrand: z.string().optional(),
  last4: z.string().optional()
});

export const caseSchema = z.object({
  id: z.string(),
  name: z.string(),
  required: z.boolean(),
  tags: z.array(z.string()).optional(),
  mode: z.enum(['latest', 'sequence', 'aggregate']).optional(),
  formQuestion: z.number().int().positive().optional(),
  observability: z.enum(['polling', 'manual', 'partial']).optional(),
  matcher: caseMatcherSchema,
  expect: z.object({
    latest: z.object({
      statusIn: z.array(z.string()).optional(),
      responseCodeIn: z.array(z.string()).optional()
    }).passthrough().optional(),
    sequence: z.object({
      statusInOrder: z.array(z.string()).optional()
    }).passthrough().optional(),
    aggregate: z.object({
      minMatches: z.number().int().nonnegative().optional()
    }).passthrough().optional()
  }).passthrough(),
  evaluator: z.object({
    type: z.enum(['declarative', 'script']),
    script: z.string().optional(),
    export: z.string().optional()
  }).optional()
});

export const packSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  extends: z.array(z.string()).optional(),
  metadata: z.object({
    region: z.string().optional(),
    industry: z.string().optional(),
    channel: z.string().optional()
  }).optional(),
  tags: z.array(z.string()).optional(),
  cases: z.object({
    directory: z.string().min(1)
  }),
  evaluators: z.object({
    default: z.string().optional(),
    overrides: z.record(z.string(), z.string()).optional()
  }).optional(),
  filters: z.object({
    accountName: z.string().optional(),
    channel: z.string().optional()
  }).optional()
});

