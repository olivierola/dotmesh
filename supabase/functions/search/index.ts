/**
 * POST /functions/v1/search → hybrid semantic + full-text search with optional
 * LLM rerank.
 *
 * Pipeline:
 *   1. Embed query (Jina).
 *   2. Call hybrid_search RPC with all filters (type, source, tags, collection,
 *      since). Over-fetch (top_k * 4, capped) so the reranker has options.
 *   3. (Optional) Pass the top-N candidates through a small LLM rerank that
 *      reads only title/description/source, then re-orders by relevance.
 *   4. Return top_k.
 *
 * Reranking is opt-out via { rerank: false } in the body and is skipped
 * automatically when GROQ_API_KEY is missing.
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { jinaEmbed, groqChat } from '../_shared/ai.ts';
import { getUserTier } from '../_shared/quotas.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const PULL_LIMITS = { free: 60, personal: 300, pro: 1200 } as const;

const NODE_TYPES = ['text', 'image', 'video', 'link', 'code', 'quote', 'page', 'action'] as const;

const searchInputSchema = z.object({
  query: z.string().min(1).max(2000),
  top_k: z.number().int().min(1).max(50).default(10),
  rerank: z.boolean().default(true),
  filters: z
    .object({
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
      since: z.string().optional(),
      node_types: z.array(z.enum(NODE_TYPES)).optional(),
      collection_id: z.string().uuid().optional(),
      author: z.string().max(120).optional(),
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

interface Hit {
  id: string;
  content: string;
  summary: string | null;
  source: string;
  source_url: string | null;
  source_app: string | null;
  node_type: string | null;
  entities: unknown;
  tags: string[];
  user_tags: string[];
  metadata: Record<string, unknown> | null;
  created_at: string;
  score: number;
}

/**
 * Filter post-RPC by fields not supported by the SQL function (currently:
 * extracted.author). We keep author filtering in JS because authors are
 * inside metadata.extracted.author (deeply nested) and infrequent enough
 * that an extra index on metadata isn't justified yet.
 */
function applyJsFilters(
  hits: Hit[],
  filters: z.infer<typeof searchInputSchema>['filters'],
): Hit[] {
  if (!filters) return hits;
  let out = hits;
  if (filters.author) {
    const needle = filters.author.toLowerCase();
    out = out.filter((h) => {
      const author = (h.metadata?.extracted as { author?: string | null } | undefined)?.author;
      return typeof author === 'string' && author.toLowerCase().includes(needle);
    });
  }
  return out;
}

async function rerankWithLLM(query: string, hits: Hit[], topK: number): Promise<Hit[]> {
  if (hits.length <= topK) return hits;
  // Cap input to keep latency / tokens under control
  const candidates = hits.slice(0, Math.min(20, hits.length));

  const list = candidates
    .map((h, i) => {
      const ex = h.metadata?.extracted as
        | { title?: string | null; description?: string | null; author?: string | null }
        | undefined;
      const title = ex?.title ?? h.summary ?? h.content.slice(0, 120);
      const desc = ex?.description ?? h.summary ?? '';
      const author = ex?.author;
      const meta = [h.node_type, h.source_app ?? h.source, author].filter(Boolean).join(' · ');
      return `${i + 1}. [${meta}] ${title}\n   ${desc.slice(0, 200)}`;
    })
    .join('\n');

  const sys =
    'You rerank search hits for a memory app. Return STRICT JSON: ' +
    '{"order": [<1-based indices in best-to-worst order>]}. ' +
    'Include only candidates that are actually relevant to the query — drop the rest. No prose.';

  const user = `Query: ${query}

Candidates:
${list}

Return up to ${topK} indices, best first.`;

  const result = await groqChat({
    model: 'llama-3.1-8b-instant',
    systemPrompt: sys,
    userPrompt: user,
    jsonMode: true,
    maxTokens: 200,
    feature: 'search-rerank',
  });

  if (!result) return hits.slice(0, topK);
  try {
    const parsed = JSON.parse(result) as { order?: unknown };
    if (!Array.isArray(parsed.order)) return hits.slice(0, topK);
    const seen = new Set<number>();
    const reordered: Hit[] = [];
    for (const idx of parsed.order) {
      if (typeof idx !== 'number') continue;
      const i = idx - 1;
      if (i < 0 || i >= candidates.length || seen.has(i)) continue;
      seen.add(i);
      reordered.push(candidates[i]!);
      if (reordered.length >= topK) break;
    }
    // Fill with leftover candidates if the LLM dropped too many
    if (reordered.length < topK) {
      for (let i = 0; i < candidates.length && reordered.length < topK; i++) {
        if (!seen.has(i)) reordered.push(candidates[i]!);
      }
    }
    return reordered;
  } catch {
    return hits.slice(0, topK);
  }
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

    const embedding = await jinaEmbed(input.query);
    const zeroVec = embedding ?? new Array(1024).fill(0);

    // Over-fetch when rerank is enabled (more candidates → better top-K).
    const willRerank = input.rerank && !!Deno.env.get('GROQ_API_KEY');
    const fetchK = willRerank
      ? Math.min(20, Math.max(input.top_k * 4, 10))
      : input.top_k;

    const { data, error } = await client.rpc('hybrid_search', {
      p_query_text: input.query,
      p_query_embedding: zeroVec,
      p_top_k: fetchK,
      p_filter_tags: input.filters?.tags ?? null,
      p_filter_since: parseInterval(input.filters?.since),
      p_filter_source: input.filters?.source ?? null,
      p_filter_types: input.filters?.node_types ?? null,
      p_filter_collection: input.filters?.collection_id ?? null,
    });

    if (error) {
      console.error('hybrid_search error', error);
      return errorResponse('search_failed', 500, error);
    }

    let hits = ((data ?? []) as Hit[]);
    hits = applyJsFilters(hits, input.filters);

    if (willRerank && hits.length > input.top_k) {
      hits = await rerankWithLLM(input.query, hits, input.top_k);
    } else {
      hits = hits.slice(0, input.top_k);
    }

    const service = createServiceClient();
    service
      .rpc('increment_usage', { p_user_id: userId, p_field: 'pulls_count', p_amount: 1 })
      .then(() => {})
      .catch(() => {});

    return jsonResponse({ results: hits, reranked: willRerank });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('search error', e);
    return errorResponse('internal_error', 500);
  }
});
