/**
 * POST /functions/v1/nodes  → create a context node
 * GET  /functions/v1/nodes  → list user nodes (paginated)
 *
 * Sync path: insert minimal row, return node_id <200ms.
 * Heavy work (NER, summary, embedding, edges) runs async via the
 * `process-node` function triggered by Realtime / cron (TODO Phase 1).
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { getUserTier, isWithinQuota } from '../_shared/quotas.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';
import { cleanupCapture } from '../_shared/cleanup-capture.ts';

const RATE_LIMITS = {
  free: 30,
  personal: 120,
  pro: 600,
} as const;

const createNodeInputSchema = z.object({
  content: z.string().min(1).max(50000),
  source: z.string().min(1).max(100),
  source_url: z.string().url().optional().nullable(),
  source_app: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  ttl: z
    .string()
    .regex(/^\d+[hdwm]$/)
    .optional()
    .nullable(),
  acl_agents: z.array(z.string().min(1).max(100)).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
  fingerprint: z.string().min(8).max(128).optional(),
  score: z.number().min(0).max(1).optional(),
  sensitivity: z.number().min(0).max(1).optional(),
});

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function ttlToTimestamp(ttl: string | null | undefined): string | null {
  if (!ttl) return null;
  const m = ttl.match(/^(\d+)([hdwm])$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms =
    unit === 'h' ? n * 3600_000 : unit === 'd' ? n * 86400_000 : unit === 'w' ? n * 604800_000 : n * 2592000_000;
  return new Date(Date.now() + ms).toISOString();
}

async function handleCreate(req: Request): Promise<Response> {
  const { userId, client } = await requireUser(req);
  const raw = await parseJsonBody<unknown>(req);

  const parsed = createNodeInputSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse('invalid_payload', 400, parsed.error.format());
  }
  const input = parsed.data;

  // Quota check
  const tier = await getUserTier(client, userId);

  // Rate limit (per-minute writes)
  await enforceRateLimit(userId, 'write', RATE_LIMITS[tier], 60);

  const { count } = await client
    .from('context_nodes')
    .select('id', { count: 'exact', head: true });
  const quota = isWithinQuota({
    tier,
    action: 'create_node',
    currentCounts: { nodes_total: count ?? 0 },
  });
  if (!quota.ok) return errorResponse(`quota_exceeded:${quota.reason}`, 402);

  // ---- Denoise the captured text before persisting it ----
  // The extension sends a lot of raw HTML-derived noise (nav menus, cookie
  // banners, scroll-glue copy). Cleaning here keeps the embedding, NER and
  // every downstream search relevance pass focused on the actual content.
  const metaIn = (input.metadata ?? {}) as Record<string, unknown>;
  const cleanup = await cleanupCapture({
    rawContent: input.content,
    source: input.source,
    sourceUrl: input.source_url ?? null,
    sourceApp: input.source_app ?? null,
    pageTitle: (metaIn.pageTitle as string | undefined) ?? null,
    captureType: (metaIn.captureType as string | undefined) ?? null,
    elementType: (metaIn.elementType as string | undefined) ?? null,
  });

  const persistedContent = cleanup.content;
  const persistedSummary = cleanup.summary;

  // Merge the AI-generated title into metadata.extracted so the graph
  // sidebar surfaces it as the document hero. Only overrides when the
  // client didn't already supply one (preserves explicit user choices).
  const existingExtracted =
    (metaIn.extracted as Record<string, unknown> | undefined) ?? {};
  const persistedMetadata = {
    ...metaIn,
    raw_content_chars: input.content.length,
    cleanup_applied: cleanup.llm_applied,
    ai_title: cleanup.title ?? null,
    ai_summary: cleanup.summary ?? null,
    extracted: {
      ...existingExtracted,
      title:
        (existingExtracted.title as string | null | undefined) ?? cleanup.title ?? null,
      description:
        (existingExtracted.description as string | null | undefined) ??
        cleanup.summary ??
        null,
    },
  };

  // Build fingerprint on the CLEANED content so two near-identical captures
  // (same article, different scroll-glue around it) deduplicate cleanly.
  const fingerprint =
    input.fingerprint ?? (await sha256Hex(`${input.source}|${persistedContent}`));

  // Insert (idempotent via unique index user_id + fingerprint)
  const { data: inserted, error } = await client
    .from('context_nodes')
    .upsert(
      {
        user_id: userId,
        source: input.source,
        source_url: input.source_url ?? null,
        source_app: input.source_app ?? null,
        content: persistedContent,
        summary: persistedSummary,
        tags: input.tags ?? [],
        acl_agents: input.acl_agents ?? ['*'],
        ttl_at: ttlToTimestamp(input.ttl),
        score: input.score ?? null,
        sensitivity: input.sensitivity ?? null,
        fingerprint,
        metadata: persistedMetadata,
      },
      { onConflict: 'user_id,fingerprint', ignoreDuplicates: false },
    )
    .select('id, created_at, summary, entities')
    .single();

  if (error || !inserted) {
    console.error('Insert error', error);
    return errorResponse('insert_failed', 500, error);
  }

  // Fire-and-forget async processing (NER + summary + embed)
  // In production this is triggered by Realtime + worker function.
  // For local dev we invoke directly without awaiting.
  invokeProcessor(inserted.id).catch((e) => console.warn('processor invoke failed', e));

  // Increment usage (service role)
  const service = createServiceClient();
  service.rpc('increment_usage', { p_user_id: userId, p_field: 'nodes_created', p_amount: 1 })
    .then(() => {})
    .catch((e: unknown) => console.warn('usage increment failed', e));

  // Audit log
  service
    .from('audit_log')
    .insert({
      user_id: userId,
      operation: 'node.create',
      node_ids: [inserted.id],
      source: input.source,
    })
    .then(() => {})
    .catch((e: unknown) => console.warn('audit log failed', e));

  return jsonResponse(
    {
      node_id: inserted.id,
      summary: inserted.summary,
      entities: inserted.entities ?? [],
      created_at: inserted.created_at,
    },
    201,
  );
}

async function invokeProcessor(nodeId: string): Promise<void> {
  const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/process-node`;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ node_id: nodeId }),
  }).catch(() => {});
}

async function handleList(req: Request): Promise<Response> {
  const { client } = await requireUser(req);
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 500);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const source = url.searchParams.get('source');
  const withCollections = url.searchParams.get('with_collections') === 'true';

  let query = client
    .from('context_nodes')
    .select(
      'id, source, source_url, source_app, content, summary, entities, tags, score, created_at, pinned, metadata, node_type',
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (source) query = query.eq('source', source);

  const { data, error } = await query;
  if (error) return errorResponse('list_failed', 500, error);

  let nodes = data ?? [];

  // Optionally join collection memberships (single round-trip via separate query,
  // then merge in JS — cheap since both sets are small).
  if (withCollections && nodes.length > 0) {
    const ids = nodes.map((n) => n.id);
    const { data: links } = await client
      .from('node_collections')
      .select('node_id, collection_id')
      .in('node_id', ids);
    const byNode = new Map<string, string[]>();
    for (const l of links ?? []) {
      const arr = byNode.get(l.node_id) ?? [];
      arr.push(l.collection_id);
      byNode.set(l.node_id, arr);
    }
    nodes = nodes.map((n) => ({ ...n, collection_ids: byNode.get(n.id) ?? [] }));
  }

  return jsonResponse({ nodes, limit, offset });
}

const patchSchema = z.object({
  summary: z.string().min(1).max(2000).optional(),
  edited_summary: z.string().min(1).max(2000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  user_tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  pinned: z.boolean().optional(),
});

async function handlePatch(req: Request, id: string): Promise<Response> {
  const { userId, client } = await requireUser(req);
  const raw = await parseJsonBody<unknown>(req);
  const parsed = patchSchema.safeParse(raw);
  if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

  const { data, error } = await client
    .from('context_nodes')
    .update(parsed.data)
    .eq('id', id)
    .select('id, summary, edited_summary, tags, user_tags, pinned, updated_at')
    .single();
  if (error || !data) return errorResponse('update_failed', 500, error);

  // Audit
  const service = createServiceClient();
  service
    .from('audit_log')
    .insert({
      user_id: userId,
      operation: 'node.update',
      node_ids: [id],
      metadata: { fields: Object.keys(parsed.data) },
    })
    .then(() => {})
    .catch(() => {});

  return jsonResponse({ node: data });
}

async function handleDelete(req: Request, id: string): Promise<Response> {
  const { userId, client } = await requireUser(req);
  const { error } = await client.from('context_nodes').delete().eq('id', id);
  if (error) return errorResponse('delete_failed', 500, error);

  const service = createServiceClient();
  service
    .from('audit_log')
    .insert({ user_id: userId, operation: 'node.delete', node_ids: [id] })
    .then(() => {})
    .catch(() => {});

  return jsonResponse({ ok: true });
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  const url = new URL(req.url);
  const segments = url.pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const id = last && last !== 'nodes' ? last : null;

  try {
    if (req.method === 'POST' && !id) return await handleCreate(req);
    if (req.method === 'GET' && !id) return await handleList(req);
    if (req.method === 'PATCH' && id) return await handlePatch(req, id);
    if (req.method === 'DELETE' && id) return await handleDelete(req, id);
    return errorResponse('method_not_allowed', 405);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('unhandled', e);
    return errorResponse('internal_error', 500);
  }
});
