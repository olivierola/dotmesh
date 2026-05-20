/**
 * POST /functions/v1/inject
 * Killer feature: given a user query + target agent, return a context block
 * to inject into the prompt.
 *
 * Flow:
 * 1. Embed query (Jina) — required for relevance gating
 * 2. Apply Context Rules (ACL) → filter allowed nodes
 * 3. hybrid_search top_k
 * 4. Decide should_inject (any result above threshold)
 * 5. Format context block
 * 6. Log injection (audit + usage)
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { jinaEmbed } from '../_shared/ai.ts';
import { getUserTier, isWithinQuota } from '../_shared/quotas.ts';
import { loadUserRules, evaluateNode, redactHit, type Rule } from '../_shared/rules.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const RELEVANCE_THRESHOLD = 0.35;
const MAX_NODES = 5;
const MAX_INJECTED_CHARS = 1500;

const injectInputSchema = z.object({
  query: z.string().min(1).max(4000),
  target_agent: z.string().min(1).max(100),
  top_k: z.number().int().min(1).max(10).default(5),
});

interface SearchHit {
  id: string;
  summary: string | null;
  content: string;
  source: string;
  source_url: string | null;
  source_app: string | null;
  tags: string[];
  created_at: string;
  score: number;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const day = 86400_000;
  if (diff < day) return 'today';
  if (diff < 2 * day) return 'yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))} weeks ago`;
  return `${Math.floor(diff / (30 * day))} months ago`;
}

interface InstructionMatch {
  id: string;
  title: string;
  context: string | null;
  instruction: string;
  score: number;
}

/**
 * Compose the final block injected ahead of the user's query.
 *
 * Two stacked sections (each optional):
 *   1. user instructions ranked by relevance to the query,
 *   2. memory excerpts from the personal graph.
 *
 * Either, both, or neither may be present. Caller has already gated on
 * "at least one of the two non-empty" — this function is just formatting.
 */
function formatContextBlock(
  hits: SearchHit[],
  instructions: InstructionMatch[],
  originalQuery: string,
): string {
  const sections: string[] = [];

  if (instructions.length > 0) {
    const instr = instructions
      .map((i) => `- ${i.title}: ${i.instruction.replace(/\s+/g, ' ').trim()}`)
      .join('\n');
    sections.push(`[Custom instructions from Mesh]\n${instr}`);
  }

  if (hits.length > 0) {
    const lines = hits.map((h) => {
      const text = (h.summary ?? h.content).slice(0, 280).replace(/\s+/g, ' ').trim();
      return `- (${relativeTime(h.created_at)}) ${text}`;
    });
    sections.push(`[Context from Mesh — your personal memory]\n${lines.join('\n')}`);
  }

  let block = `${sections.join('\n\n')}\n\nYour query:\n${originalQuery}`;
  if (block.length > MAX_INJECTED_CHARS) {
    block = block.slice(0, MAX_INJECTED_CHARS - 20) + '\n...';
  }
  return block;
}

function applyContextRules(
  rules: Rule[],
  targetAgent: string,
  hits: SearchHit[],
): { kept: SearchHit[]; droppedReasons: Record<string, number> } {
  if (rules.length === 0) return { kept: hits, droppedReasons: {} };

  const kept: SearchHit[] = [];
  const droppedReasons: Record<string, number> = {};

  for (const hit of hits) {
    const verdict = evaluateNode(
      {
        id: hit.id,
        tags: hit.tags ?? [],
        source: hit.source,
        source_url: hit.source_url,
        created_at: hit.created_at,
        summary: hit.summary,
        content: hit.content,
      },
      targetAgent,
      rules,
    );
    if (!verdict.allowed) {
      const r = verdict.reason ?? 'unknown';
      droppedReasons[r] = (droppedReasons[r] ?? 0) + 1;
      continue;
    }
    kept.push(verdict.redacted ? redactHit(hit) : hit);
  }
  return { kept, droppedReasons };
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  const start = Date.now();
  try {
    const { userId, client } = await requireUser(req);
    const raw = await parseJsonBody<unknown>(req);
    const parsed = injectInputSchema.safeParse(raw);
    if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());
    const input = parsed.data;

    // Quota
    const tier = await getUserTier(client, userId);
    const today = new Date().toISOString().split('T')[0];
    const { data: usage } = await client
      .from('usage_metrics')
      .select('injections_count')
      .eq('user_id', userId)
      .eq('date', today)
      .maybeSingle();
    const quota = isWithinQuota({
      tier,
      action: 'inject',
      currentCounts: { injections_today: usage?.injections_count ?? 0 },
    });
    if (!quota.ok) return errorResponse(`quota_exceeded:${quota.reason}`, 402);

    // Burst protection (10 injections per minute regardless of daily quota)
    await enforceRateLimit(userId, 'inject', 10, 60);

    // Embed query
    const embedding = await jinaEmbed(input.query);
    const queryVec = embedding ?? new Array(1024).fill(0);

    // Run memory search and instruction matching in parallel — both need
    // the same query embedding so we can fire them concurrently.
    const [hitsRes, instructionsRes] = await Promise.all([
      client.rpc('hybrid_search', {
        p_query_text: input.query,
        p_query_embedding: queryVec,
        p_top_k: input.top_k,
        p_filter_tags: null,
        p_filter_since: null,
        p_filter_source: null,
      }),
      embedding
        ? client.rpc('match_instructions', {
            p_user_id: userId,
            p_query_embedding: queryVec,
            p_top_k: 3,
            p_min_score: 0.55,
          })
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (hitsRes.error) {
      console.error('inject search error', hitsRes.error);
      return errorResponse('search_failed', 500, hitsRes.error);
    }

    const allHits = (hitsRes.data ?? []) as SearchHit[];
    const relevant = allHits
      .filter((h) => h.score >= RELEVANCE_THRESHOLD)
      .slice(0, MAX_NODES);

    const instructions = (instructionsRes.data ?? []) as InstructionMatch[];

    // Apply Context Rules to memory hits only (instructions are user-authored
    // and not subject to redaction).
    const service = createServiceClient();
    const rules = await loadUserRules(client, userId);
    const { kept, droppedReasons } = applyContextRules(rules, input.target_agent, relevant);

    if (kept.length === 0 && instructions.length === 0) {
      // No memory worth injecting and no instruction matches — skip.
      const reason =
        relevant.length === 0
          ? 'no_relevant_context'
          : `blocked_by_rule:${JSON.stringify(droppedReasons)}`;
      return jsonResponse({
        should_inject: false,
        context_block: null,
        node_ids: [],
        instruction_ids: [],
        injection_id: null,
        reason,
      });
    }
    const filtered = kept;

    const contextBlock = formatContextBlock(filtered, instructions, input.query);
    const queryHash = await sha256Hex(input.query);
    const latency = Date.now() - start;

    // Log injection
    const { data: log } = await service
      .from('injections')
      .insert({
        user_id: userId,
        target_agent: input.target_agent,
        query_hash: queryHash,
        query_excerpt: input.query.slice(0, 100),
        node_ids: filtered.map((h) => h.id),
        injected_text: contextBlock,
        latency_ms: latency,
      })
      .select('id')
      .single();

    service
      .rpc('increment_usage', { p_user_id: userId, p_field: 'injections_count', p_amount: 1 })
      .then(() => {})
      .catch(() => {});

    return jsonResponse({
      should_inject: true,
      context_block: contextBlock,
      node_ids: filtered.map((h) => h.id),
      instruction_ids: instructions.map((i) => i.id),
      injection_id: log?.id ?? null,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('inject error', e);
    return errorResponse('internal_error', 500);
  }
});
