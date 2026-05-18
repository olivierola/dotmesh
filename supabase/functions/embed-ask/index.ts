/**
 * POST /functions/v1/embed-ask
 *   Authorization: Bearer mesh_embed_<plaintext>
 *   body: { question: string }
 *
 * Public endpoint for the embed widget. NOT protected by Supabase JWT.
 *
 *   1. Hash the bearer, look up an active embed_token row
 *   2. Validate Origin against allowed_origins
 *   3. Rate-limit per token (rate_limit_per_minute)
 *   4. Run the same RAG pipeline as /chat (one-shot, no session)
 *   5. Stream the answer back
 *
 * Deploy with --no-verify-jwt.
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { errorResponse, parseJsonBody } from '../_shared/http.ts';
import { jinaEmbed, groqChatStream } from '../_shared/ai.ts';
import { rateLimit } from '../_shared/ratelimit.ts';

const inputSchema = z.object({
  question: z.string().min(1).max(4000),
  top_k: z.number().int().min(1).max(10).default(5),
});

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isOriginAllowed(origin: string | null, allowed: string[]): boolean {
  if (!origin) return false;
  if (allowed.includes('*')) return true;
  try {
    const host = new URL(origin).host.toLowerCase();
    return allowed.some((a) => {
      try {
        return new URL(a).host.toLowerCase() === host;
      } catch {
        return a.toLowerCase() === host;
      }
    });
  } catch {
    return false;
  }
}

function embedCors(origin: string | null, allowed: string[]): Record<string, string> {
  const ok = origin && isOriginAllowed(origin, allowed);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

interface SearchHit {
  id: string;
  content: string;
  summary: string | null;
  source: string;
  created_at: string;
  score: number;
}

Deno.serve(async (req) => {
  // CORS preflight uses a generous policy because the token-bound check happens later.
  // For the actual POST we tighten origin to the token's allowlist.
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  const _ = handleCorsPreflight; // keep import
  void _;

  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!bearer.startsWith('mesh_embed_')) {
      return errorResponse('missing_token', 401);
    }
    const tokenHash = await sha256Hex(bearer);

    const service = createServiceClient();
    const { data: token, error: tokErr } = await service
      .from('embed_tokens')
      .select('id, user_id, allowed_origins, rate_limit_per_minute, scopes, active, collection_ids')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (tokErr || !token || !token.active) {
      return errorResponse('invalid_token', 401);
    }
    if (!token.scopes.includes('ask')) {
      return errorResponse('scope_denied', 403);
    }

    const origin = req.headers.get('Origin');
    const cors = embedCors(origin, token.allowed_origins);

    if (!isOriginAllowed(origin, token.allowed_origins)) {
      return new Response(JSON.stringify({ error: 'origin_not_allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    // Rate limit per token
    const rl = await rateLimit(
      `embed:${token.id}`,
      'ask',
      token.rate_limit_per_minute,
      60,
    );
    if (!rl.ok) {
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    const raw = await parseJsonBody<unknown>(req);
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: 'invalid_payload', details: parsed.error.format() }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...cors } },
      );
    }

    // Run RAG with service role but SCOPED to token.user_id manually.
    const embedding = await jinaEmbed(parsed.data.question);
    const queryVec = embedding ?? new Array(1024).fill(0);

    // We overfetch when the token is collection-scoped so the post-filter
    // doesn't starve the result set.
    const collectionScoped =
      Array.isArray(token.collection_ids) && (token.collection_ids as string[]).length > 0;
    const overfetch = collectionScoped ? Math.max(parsed.data.top_k * 4, 20) : parsed.data.top_k;

    const { data: hits } = await service.rpc('hybrid_search_for_user', {
      p_user_id: token.user_id,
      p_query_text: parsed.data.question,
      p_query_embedding: queryVec,
      p_top_k: overfetch,
    });
    let allHits = ((hits ?? []) as SearchHit[]).filter((h) => h.score > 0.15);

    // Apply collection scope: keep only nodes that belong to one of the allowed
    // collections. Done with one batched query.
    if (collectionScoped && allHits.length > 0) {
      const { data: assocs } = await service
        .from('node_collections')
        .select('node_id')
        .in('node_id', allHits.map((h) => h.id))
        .in('collection_id', token.collection_ids as string[]);
      const allowed = new Set((assocs ?? []).map((a) => a.node_id as string));
      allHits = allHits.filter((h) => allowed.has(h.id)).slice(0, parsed.data.top_k);
    }

    const contextBlock =
      allHits.length === 0
        ? 'Relevant memories: (none)'
        : 'Relevant memories:\n' +
          allHits
            .map((h, i) => `[${i + 1}] ${(h.summary ?? h.content).slice(0, 280)}`)
            .join('\n');

    const stream = await groqChatStream({
      messages: [
        {
          role: 'system',
          content:
            'You are Mesh, answering on behalf of the owner of these memories. Be concise (max 4 sentences). Cite [n] inline when you use a memory. If memories are empty, answer from general knowledge but say "I have no specific memory about this".',
        },
        { role: 'system', content: contextBlock },
        { role: 'user', content: parsed.data.question },
      ],
      maxTokens: 600,
      temperature: 0.4,
    });

    // Bump usage stats fire-and-forget
    service
      .from('embed_tokens')
      .update({ last_used_at: new Date().toISOString(), call_count: (token as { call_count?: number }).call_count ?? 0 + 1 })
      .eq('id', token.id)
      .then(() => {})
      .catch(() => {});

    return new Response(stream, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (e) {
    console.error('embed-ask error', e);
    return errorResponse('internal_error', 500);
  }
});
