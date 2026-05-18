/**
 * POST /functions/v1/search → hybrid semantic + full-text search
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { jinaEmbed } from '../_shared/ai.ts';
import { getUserTier } from '../_shared/quotas.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const PULL_LIMITS = { free: 60, personal: 300, pro: 1200 } as const;

const searchInputSchema = z.object({
  query: z.string().min(1).max(2000),
  top_k: z.number().int().min(1).max(50).default(5),
  filters: z
    .object({
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
      since: z.string().optional(),
    })
    .optional(),
});

function parseInterval(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.match(/^(\d+)([hdwm])$/);
  if (!m) return null;
  const n = m[1];
  const unit = m[2];
  const mapping: Record<string, string> = { h: 'hours', d: 'days', w: 'weeks', m: 'months' };
  return `${n} ${mapping[unit]}`;
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    const { userId, client } = await requireUser(req);
    const raw = await parseJsonBody<unknown>(req);
    const parsed = searchInputSchema.safeParse(raw);
    if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());
    const input = parsed.data;

    const tier = await getUserTier(client, userId);
    await enforceRateLimit(userId, 'pull', PULL_LIMITS[tier], 60);

    // Build embedding (Jina). If unavailable, fallback to FTS only via zero-vector.
    const embedding = await jinaEmbed(input.query);
    const zeroVec = embedding ?? new Array(1024).fill(0);

    const { data, error } = await client.rpc('hybrid_search', {
      p_query_text: input.query,
      p_query_embedding: zeroVec,
      p_top_k: input.top_k,
      p_filter_tags: input.filters?.tags ?? null,
      p_filter_since: parseInterval(input.filters?.since),
      p_filter_source: input.filters?.source ?? null,
    });

    if (error) {
      console.error('hybrid_search error', error);
      return errorResponse('search_failed', 500, error);
    }

    // Increment pulls (service role, fire-and-forget)
    const service = createServiceClient();
    service
      .rpc('increment_usage', { p_user_id: userId, p_field: 'pulls_count', p_amount: 1 })
      .then(() => {})
      .catch(() => {});

    return jsonResponse({ results: data ?? [] });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('search error', e);
    return errorResponse('internal_error', 500);
  }
});
