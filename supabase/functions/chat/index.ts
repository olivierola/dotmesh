/**
 * POST /functions/v1/chat
 *   body: { session_id?: string, message: string }
 *
 * Implements RAG over the user's own memory:
 *   1. Embed the user message
 *   2. Hybrid search top_k memories under the user's RLS scope
 *   3. Build prompt: system instructions + retrieved memories + recent chat history + new message
 *   4. Stream the assistant response back as text/plain
 *   5. On stream end, persist user + assistant messages with cited_nodes
 *
 * Returns: text/event-stream-ish — we use a custom protocol with these line prefixes:
 *   META {json}   first line, before any content
 *   {plain text}  streamed deltas
 *
 * The frontend can parse this in chunks easily.
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight, corsHeaders } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { errorResponse, parseJsonBody } from '../_shared/http.ts';
import { jinaEmbed, groqChatStream } from '../_shared/ai.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';
import { getUserTier } from '../_shared/quotas.ts';
import { detectAgentIntent, invokeAgent, formatAgentBlock } from '../_shared/agent-router.ts';

const inputSchema = z.object({
  session_id: z.string().uuid().optional().nullable(),
  message: z.string().min(1).max(8000),
  top_k: z.number().int().min(1).max(20).default(8),
});

const CHAT_LIMITS = { free: 30, personal: 120, pro: 600 } as const;

interface SearchHit {
  id: string;
  content: string;
  summary: string | null;
  source: string;
  source_url: string | null;
  source_app?: string | null;
  entities?: Array<{ value: string; type: string; normalized: string }>;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
  created_at: string;
  score: number;
}

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

function buildSystemPrompt(): string {
  return [
    "You are Mesh, the user's personal AI assistant.",
    'You have access to a curated set of memories captured from the user activity (browsing, AI sessions, connected apps).',
    'Answer questions using these memories as your primary knowledge source.',
    'Citation rules:',
    '- When you use a memory, cite it inline as [n] where n is the 1-indexed position in the "Relevant memories" list.',
    '- If no memory is relevant, say so plainly and answer from general knowledge.',
    'Tone: concise, friendly, French OR English matching the user message language.',
    'Never invent personal details about the user that are not present in the memories.',
  ].join('\n');
}

function buildContextBlock(hits: SearchHit[]): string {
  if (hits.length === 0) return 'Relevant memories: (none found)';
  const lines = hits.map((h, i) => {
    const date = new Date(h.created_at).toISOString().split('T')[0];
    const md = (h.metadata ?? {}) as Record<string, unknown>;
    const captureType = (md.captureType as string | undefined) ?? null;
    const elementType = (md.elementType as string | undefined) ?? null;
    const mediaUrl = (md.mediaUrl as string | undefined) ?? null;
    const pageTitle = (md.pageTitle as string | undefined) ?? null;
    const heading = (md.heading as string | undefined) ?? null;
    const author = (md.author as string | undefined) ?? null;
    const surroundingContext = (md.surroundingContext as string | undefined) ?? null;

    // Compose a rich, type-aware line. Stay under ~600 chars per memory.
    const body = (h.summary ?? h.content).replace(/\s+/g, ' ').trim();

    const headerBits: string[] = [`[${i + 1}]`, `(${date}`];
    if (captureType) headerBits.push(`· ${captureType}`);
    if (h.source_app) headerBits.push(`· ${h.source_app}`);
    headerBits.push(`)`);

    const tail: string[] = [];
    if (heading) tail.push(`heading="${heading.slice(0, 120)}"`);
    if (author) tail.push(`author="${author.slice(0, 60)}"`);
    if (pageTitle && !heading) tail.push(`page="${pageTitle.slice(0, 120)}"`);
    if (elementType && elementType !== 'text') tail.push(`type=${elementType}`);
    if (mediaUrl) tail.push(`media=${mediaUrl}`);
    if (h.source_url) tail.push(`url=${h.source_url}`);

    let line = `${headerBits.join(' ')} ${body.slice(0, 360)}`;
    if (surroundingContext && (elementType === 'image' || elementType === 'video')) {
      line += `\n     context: ${surroundingContext.slice(0, 240)}`;
    }
    if (tail.length) line += `\n     ${tail.join(' · ')}`;
    return line;
  });
  return `Relevant memories (cite as [n]):\n${lines.join('\n')}`;
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    const { userId, client } = await requireUser(req);

    const raw = await parseJsonBody<unknown>(req);
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());
    const input = parsed.data;

    // Rate-limit chat messages per minute (LLM cost is the dominant factor)
    const tier = await getUserTier(client, userId);
    await enforceRateLimit(userId, 'chat', CHAT_LIMITS[tier], 60);

    // Ensure session
    let sessionId = input.session_id ?? null;
    if (!sessionId) {
      const title = input.message.slice(0, 60);
      const { data: created, error: errSess } = await client
        .from('chat_sessions')
        .insert({ user_id: userId, title })
        .select('id')
        .single();
      if (errSess || !created) return errorResponse('session_create_failed', 500, errSess);
      sessionId = created.id;
    }

    // Insert user message immediately (so the UI can refresh history if needed)
    const { error: userMsgErr } = await client.from('chat_messages').insert({
      session_id: sessionId,
      user_id: userId,
      role: 'user',
      content: input.message,
    });
    if (userMsgErr) return errorResponse('user_msg_insert_failed', 500, userMsgErr);

    // Agent routing: does the message look like a request for an autonomous agent?
    // Runs in parallel with the embedding to keep latency flat.
    const agentIntentPromise = detectAgentIntent(input.message);

    // RAG: embed + hybrid search.
    // When embedding fails (e.g. JINA_API_KEY missing), fall back to lexical-only
    // search via a direct FTS query — avoids polluting hybrid_search with a zero
    // vector that returns near-random results.
    const embedding = await jinaEmbed(input.message);

    let hits: SearchHit[] = [];
    if (embedding) {
      const { data: hitsRaw, error: searchErr } = await client.rpc('hybrid_search', {
        p_query_text: input.message,
        p_query_embedding: embedding,
        p_top_k: input.top_k,
        p_filter_tags: null,
        p_filter_since: null,
        p_filter_source: null,
      });
      if (searchErr) {
        console.warn('[Mesh] chat hybrid_search failed', searchErr);
      } else {
        hits = ((hitsRaw ?? []) as SearchHit[]).filter((h) => h.score > 0.2);
      }
    } else {
      // No embedding available — fall back to FTS via the same RPC by sending a
      // zero vector AND boosting top_k. Sparse branch in hybrid_search still
      // returns results; we just lower the score threshold and re-rank by recency
      // for ties.
      console.log('[Mesh] chat running in FTS-only mode (no embedding)');
      const { data: ftsRows, error: ftsErr } = await client
        .from('context_nodes')
        .select(
          'id, content, summary, source, source_url, source_app, entities, tags, user_tags, created_at',
        )
        .textSearch('content_tsv', input.message, { type: 'plain', config: 'simple' })
        .order('created_at', { ascending: false })
        .limit(input.top_k);
      if (ftsErr) {
        console.warn('[Mesh] chat fts fallback failed', ftsErr);
      } else {
        hits = (ftsRows ?? []).map((r) => ({ ...r, score: 0.5 })) as SearchHit[];
      }
    }

    // Recent chat history (last 8 turns)
    const { data: historyRows } = await client
      .from('chat_messages')
      .select('role, content')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(16);
    const history = ((historyRows ?? []) as HistoryMessage[])
      .reverse()
      .slice(-8)
      // Drop the message we just inserted — it's the "current" turn.
      .filter((m, idx, arr) => !(idx === arr.length - 1 && m.role === 'user'));

    // Resolve agent routing — if matched, run the agent now and inject its
    // output as an extra system message before the user turn.
    const agentIntent = await agentIntentPromise;
    let agentBlock: string | null = null;
    if (agentIntent !== 'none') {
      const out = await invokeAgent(agentIntent, userId);
      if (out) agentBlock = formatAgentBlock(agentIntent, out);
    }

    // Build LLM messages
    const llmMessages = [
      { role: 'system' as const, content: buildSystemPrompt() },
      { role: 'system' as const, content: buildContextBlock(hits) },
      ...(agentBlock
        ? [
            {
              role: 'system' as const,
              content:
                `An autonomous agent ("${agentIntent}") was run to help with this request. ` +
                `Use the result below verbatim where relevant — do not paraphrase the items list, ` +
                `but you may add a brief narrative.\n\n${agentBlock}`,
            },
          ]
        : []),
      ...history.map((h) => ({
        role: h.role as 'user' | 'assistant',
        content: h.content,
      })),
      { role: 'user' as const, content: input.message },
    ];

    // Stream
    const startMs = Date.now();
    const upstream = await groqChatStream({
      messages: llmMessages,
      model: 'llama-3.3-70b-versatile',
      maxTokens: 1024,
      temperature: 0.3,
    });

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const collected: string[] = [];
    const service = createServiceClient();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Meta line first — frontend reads it before content.
        const meta = {
          session_id: sessionId,
          cited_nodes: hits.map((h) => h.id),
          hits: hits.map((h, i) => ({
            index: i + 1,
            id: h.id,
            summary: h.summary ?? h.content.slice(0, 180),
            source: h.source,
            source_url: h.source_url,
          })),
          agent_used: agentIntent !== 'none' && agentBlock ? agentIntent : null,
        };
        controller.enqueue(encoder.encode(`META ${JSON.stringify(meta)}\n`));

        const reader = upstream.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            collected.push(decoder.decode(value, { stream: true }));
            controller.enqueue(value);
          }
        } catch (e) {
          console.error('chat stream error', e);
          controller.enqueue(encoder.encode(`\n[stream error]`));
        }
        controller.close();

        // Persist assistant message after stream completes
        const fullText = collected.join('').trim();
        if (fullText) {
          await service
            .from('chat_messages')
            .insert({
              session_id: sessionId,
              user_id: userId,
              role: 'assistant',
              content: fullText,
              cited_nodes: hits.map((h) => h.id),
              model: 'llama-3.3-70b-versatile',
              latency_ms: Date.now() - startMs,
            })
            .then(() => {})
            .catch((e: unknown) => console.warn('assistant insert failed', e));

          // Auto-rename session if it has the default title
          service
            .from('chat_sessions')
            .update({ title: input.message.slice(0, 60) })
            .eq('id', sessionId)
            .eq('title', 'New chat')
            .then(() => {})
            .catch(() => {});
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('chat error', e);
    return errorResponse('internal_error', 500, (e as Error).message);
  }
});
