/**
 * Collections CRUD.
 *
 * GET    /functions/v1/collections                list (with stats)
 * GET    /functions/v1/collections/:id            single + node count
 * POST   /functions/v1/collections                create — translates rule_prompt → filter
 * PATCH  /functions/v1/collections/:id            update name/description/icon/color/rule_prompt
 *                                                 (re-runs translate if rule_prompt changes)
 * DELETE /functions/v1/collections/:id            delete (default cannot be deleted)
 * POST   /functions/v1/collections/:id/preview    body: { rule_prompt }
 *                                                 dry-run: returns proposed filter + count
 * POST   /functions/v1/collections/:id/reclassify backfill: re-run classifier on all
 *                                                 user's nodes against this collection
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { describeToFilter } from '../_shared/collections-classifier.ts';
import { llmAssignCollections } from '../_shared/collections-llm-assigner.ts';
import { readExtracted, fallbackExtractedFromContent } from '../_shared/extracted.ts';

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  rule_prompt: z.string().max(800).optional(),
  icon: z.string().max(8).optional(),
  color: z.string().max(20).optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(400).optional(),
  rule_prompt: z.string().max(800).optional(),
  icon: z.string().max(8).optional(),
  color: z.string().max(20).optional(),
  pinned: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

const previewSchema = z.object({
  rule_prompt: z.string().min(1).max(800),
});

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  try {
    const { userId, client } = await requireUser(req);
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    const beforeLast = segments[segments.length - 2];

    // /collections/reclassify-orphans — run the LLM assigner on every node
    // currently attached ONLY to Inbox (no thematic home). Bounded, idempotent.
    if (req.method === 'POST' && last === 'reclassify-orphans') {
      const service = createServiceClient();

      // 1. find the default (Inbox) collection id
      const { data: inbox } = await service
        .from('collections')
        .select('id')
        .eq('user_id', userId)
        .eq('is_default', true)
        .maybeSingle();
      if (!inbox) return errorResponse('no_inbox', 500);

      // 2. nodes attached to Inbox AND nothing else
      const { data: orphanRows } = await service
        .from('node_collections')
        .select('node_id')
        .eq('user_id', userId)
        .eq('collection_id', inbox.id);
      const inboxIds = (orphanRows ?? []).map((r) => r.node_id as string);
      if (inboxIds.length === 0) {
        return jsonResponse({ ok: true, scanned: 0, reassigned: 0, created: [] });
      }

      // For each, check if it has another collection — if yes, skip.
      const { data: otherRows } = await service
        .from('node_collections')
        .select('node_id, collection_id')
        .in('node_id', inboxIds);
      const hasOther = new Set<string>();
      for (const r of otherRows ?? []) {
        if (r.collection_id !== inbox.id) hasOther.add(r.node_id as string);
      }
      const targetIds = inboxIds.filter((id) => !hasOther.has(id));
      // Cap to avoid runaway cost on first big backfill.
      const batch = targetIds.slice(0, 50);

      // 3. for each target node, fetch row & run LLM assigner
      const { data: nodes } = await service
        .from('context_nodes')
        .select('id, content, metadata, tags, source, source_url, source_app')
        .in('id', batch);

      let reassigned = 0;
      const created: string[] = [];
      for (const n of nodes ?? []) {
        const extracted =
          readExtracted(n.metadata) ??
          fallbackExtractedFromContent(
            n.content ?? '',
            n.source ?? 'extension',
            n.source_url as string | null,
            n.source_app as string | null,
          );
        const r = await llmAssignCollections(service, {
          nodeId: n.id as string,
          userId,
          extracted,
          rawContent: (n.content as string) ?? '',
          tags: ((n.tags as string[] | null) ?? []),
          deterministicMatchedNonDefault: false,
        });
        if (r.added > 0) reassigned += r.added;
        if (r.created_collection) created.push(r.created_collection);
      }
      return jsonResponse({
        ok: true,
        scanned: batch.length,
        skipped: targetIds.length - batch.length,
        reassigned,
        created,
      });
    }

    // /collections/preview — dry-run on a rule_prompt, no id needed
    if (req.method === 'POST' && last === 'preview') {
      const body = await parseJsonBody<unknown>(req);
      const parsed = previewSchema.safeParse(body);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const filter = await describeToFilter(parsed.data.rule_prompt);
      // Count nodes that would match using node_matches_filter SQL helper.
      const { data: nodes } = await client
        .from('context_nodes')
        .select('id')
        .order('created_at', { ascending: false })
        .limit(500);
      let matchCount = 0;
      for (const n of nodes ?? []) {
        const { data: matches } = await client.rpc('node_matches_filter', {
          p_node_id: n.id,
          p_filter: filter,
        });
        if (matches) matchCount++;
      }
      return jsonResponse({ filter, sampled: nodes?.length ?? 0, matched: matchCount });
    }

    // /collections/:id/reclassify
    if (req.method === 'POST' && last === 'reclassify' && beforeLast && beforeLast !== 'collections') {
      const { data: col } = await client
        .from('collections')
        .select('id, user_id, filter')
        .eq('id', beforeLast)
        .maybeSingle();
      if (!col) return errorResponse('not_found', 404);

      const service = createServiceClient();
      // Clear old auto-assignments
      await service
        .from('node_collections')
        .delete()
        .eq('collection_id', col.id)
        .eq('source', 'auto');

      // Re-evaluate every node
      const { data: nodes } = await client
        .from('context_nodes')
        .select('id')
        .order('created_at', { ascending: false });
      let added = 0;
      for (const n of nodes ?? []) {
        const { data: matches } = await client.rpc('node_matches_filter', {
          p_node_id: n.id,
          p_filter: col.filter,
        });
        if (matches) {
          await service.from('node_collections').insert({
            node_id: n.id,
            collection_id: col.id,
            user_id: userId,
            source: 'auto',
          }).then(() => added++).catch(() => {});
        }
      }
      return jsonResponse({ ok: true, matched: added });
    }

    const id = last && last !== 'collections' ? last : null;

    if (req.method === 'GET' && !id) {
      const { data, error } = await client
        .from('collections_with_stats')
        .select('*')
        .order('pinned', { ascending: false })
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) return errorResponse('list_failed', 500, error);
      return jsonResponse({ collections: data ?? [] });
    }

    if (req.method === 'GET' && id) {
      const { data, error } = await client
        .from('collections_with_stats')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error || !data) return errorResponse('not_found', 404, error);
      return jsonResponse({ collection: data });
    }

    if (req.method === 'POST' && !id) {
      const body = await parseJsonBody<unknown>(req);
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const filter = parsed.data.rule_prompt
        ? await describeToFilter(parsed.data.rule_prompt)
        : {};

      const { data, error } = await client
        .from('collections')
        .insert({
          user_id: userId,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          rule_prompt: parsed.data.rule_prompt ?? null,
          icon: parsed.data.icon ?? null,
          color: parsed.data.color ?? null,
          filter,
          is_default: false,
        })
        .select('*')
        .single();
      if (error) return errorResponse('insert_failed', 500, error);

      // Fire-and-forget initial classification (small synchronous batch).
      const service = createServiceClient();
      service
        .from('context_nodes')
        .select('id')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(200)
        .then(async ({ data: nodes }) => {
          for (const n of nodes ?? []) {
            const { data: matches } = await service.rpc('node_matches_filter', {
              p_node_id: n.id,
              p_filter: filter,
            });
            if (matches) {
              await service
                .from('node_collections')
                .insert({
                  node_id: n.id,
                  collection_id: data.id,
                  user_id: userId,
                  source: 'auto',
                })
                .catch(() => {});
            }
          }
        })
        .catch(() => {});

      return jsonResponse({ collection: data }, 201);
    }

    if (req.method === 'PATCH' && id) {
      const body = await parseJsonBody<unknown>(req);
      const parsed = patchSchema.safeParse(body);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const updates: Record<string, unknown> = { ...parsed.data };
      // If rule_prompt changed, retranslate to filter
      if (parsed.data.rule_prompt !== undefined) {
        updates.filter = parsed.data.rule_prompt
          ? await describeToFilter(parsed.data.rule_prompt)
          : {};
      }

      const { data, error } = await client
        .from('collections')
        .update(updates)
        .eq('id', id)
        .select('*')
        .single();
      if (error) return errorResponse('update_failed', 500, error);
      return jsonResponse({ collection: data });
    }

    if (req.method === 'DELETE' && id) {
      // Default ("inbox") collection cannot be deleted.
      const { data: existing } = await client
        .from('collections')
        .select('is_default')
        .eq('id', id)
        .maybeSingle();
      if (existing?.is_default) {
        return errorResponse('cannot_delete_default', 400);
      }
      const { error } = await client.from('collections').delete().eq('id', id);
      if (error) return errorResponse('delete_failed', 500, error);
      return jsonResponse({ ok: true });
    }

    return errorResponse('method_not_allowed', 405);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('collections error', e);
    return errorResponse('internal_error', 500);
  }
});
