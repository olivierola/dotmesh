import { z } from 'zod';

/**
 * Zod schemas — runtime validation for API boundaries.
 * Mirror types.ts but with parse-able schemas.
 */

export const entityTypeSchema = z.enum([
  'PERSON',
  'ORG',
  'LOCATION',
  'DATE',
  'PROJECT',
  'PRODUCT',
  'TOPIC',
]);

export const entitySchema = z.object({
  type: entityTypeSchema,
  value: z.string().min(1).max(200),
  normalized: z.string().min(1).max(200),
});

export const tierSchema = z.enum(['free', 'personal', 'pro']);

export const ttlSchema = z
  .string()
  .regex(/^\d+[hdwm]$/)
  .optional()
  .nullable();

// POST /v1/nodes
export const createNodeInputSchema = z.object({
  content: z.string().min(1).max(50000),
  source: z.string().min(1).max(100),
  source_url: z.string().url().optional().nullable(),
  source_app: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  ttl: ttlSchema,
  acl_agents: z.array(z.string().min(1).max(100)).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
  fingerprint: z.string().min(8).max(128).optional(),
  score: z.number().min(0).max(1).optional(),
  sensitivity: z.number().min(0).max(1).optional(),
});
export type CreateNodeInput = z.infer<typeof createNodeInputSchema>;

export const createNodeResponseSchema = z.object({
  node_id: z.string().uuid(),
  summary: z.string().nullable(),
  entities: z.array(entitySchema),
  created_at: z.string(),
});
export type CreateNodeResponse = z.infer<typeof createNodeResponseSchema>;

// POST /v1/search
export const searchInputSchema = z.object({
  query: z.string().min(1).max(2000),
  top_k: z.number().int().min(1).max(50).default(5),
  filters: z
    .object({
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
      since: z.string().optional(), // ISO-8601 duration or '7d' style
    })
    .optional(),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

// POST /v1/inject
export const injectInputSchema = z.object({
  query: z.string().min(1).max(4000),
  target_agent: z.string().min(1).max(100),
  top_k: z.number().int().min(1).max(10).default(5),
});
export type InjectInput = z.infer<typeof injectInputSchema>;

export const injectResponseSchema = z.object({
  should_inject: z.boolean(),
  context_block: z.string().nullable(),
  node_ids: z.array(z.string().uuid()),
  injection_id: z.string().uuid().nullable(),
  reason: z.string().optional(),
});
export type InjectResponse = z.infer<typeof injectResponseSchema>;

// POST /v1/traverse
export const traverseInputSchema = z.object({
  entity: z.string().min(1).max(200),
  depth: z.number().int().min(1).max(3).default(2),
  relation: z.string().optional(),
});
export type TraverseInput = z.infer<typeof traverseInputSchema>;
