/**
 * POST /functions/v1/reprocess-all
 *
 * Recomputes embedding + entities + edges + collection assignments for ALL
 * the current user's nodes that lack an embedding or have empty entities.
 *
 * Authenticated via user JWT (RLS guarantees scope to auth.uid()).
 *
 * Usage: call this once after you set JINA_API_KEY for the first time,
 * or after wiping/restoring data.
 *
 * Returns a small JSON summary: { processed, embedded, edges_total }
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';
import { extractEntities, summarize, jinaEmbed } from '../_shared/ai.ts';
import { inferEdgesForNode } from '../_shared/edges.ts';
import { classifyNodeIntoCollections } from '../_shared/collections-assigner.ts';

const BATCH_LIMIT = 100;

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    const { userId, client } = await requireUser(req);

    // Find nodes missing embedding OR with empty entities (broken processing)
    const { data: nodes, error } = await client
      .from('context_nodes')
      .select('id, user_id, content, summary, embedding, entities')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(BATCH_LIMIT);

    if (error) return errorResponse('list_failed', 500, error);

    const service = createServiceClient();
    let processed = 0;
    let embedded = 0;
    let edgesTotal = 0;
    let collectionsTotal = 0;
    const errors: string[] = [];

    /**
     * True if the existing summary is essentially a bare URL or one of our
     * internal "[Page] https://…" / "[Image] …" placeholders — these are the
     * ones we want to regenerate even when summary is technically present.
     */
    function summaryLooksRaw(s: string | null): boolean {
      if (!s) return true;
      const t = s.trim();
      if (!t) return true;
      if (/^\[(Page|Image|Video|Link|Quote|Code)\]/i.test(t)) return true;
      if (/^https?:\/\/\S+$/i.test(t)) return true;
      return false;
    }

    for (const node of nodes ?? []) {
      try {
        const needsEmbed = !node.embedding;
        const ents = (node.entities ?? []) as Array<{ value: string }>;
        const needsEnts = !Array.isArray(ents) || ents.length === 0;
        const needsSummary = !node.summary || summaryLooksRaw(node.summary as string | null);

        if (!needsEmbed && !needsEnts && !needsSummary) {
          continue; // already healthy
        }

        const [newEntities, newSummary, newEmbedding] = await Promise.all([
          needsEnts ? extractEntities(node.content) : Promise.resolve(ents),
          needsSummary ? summarize(node.content) : Promise.resolve(node.summary),
          needsEmbed ? jinaEmbed(node.summary ?? node.content) : Promise.resolve(node.embedding),
        ]);

        const updates: Record<string, unknown> = {};
        if (needsEnts) updates.entities = newEntities;
        if (needsSummary && newSummary) updates.summary = newSummary;
        if (needsEmbed && newEmbedding) {
          updates.embedding = newEmbedding;
          embedded++;
        }

        if (Object.keys(updates).length > 0) {
          await service.from('context_nodes').update(updates).eq('id', node.id);
        }

        // Re-run edge inference with the fresh data
        const inferred = await inferEdgesForNode(service, {
          id: node.id,
          user_id: node.user_id,
          entities: (newEntities as Array<{ type: string; value: string; normalized: string }>) ?? [],
          embedding: (newEmbedding as number[] | null) ?? null,
        });
        edgesTotal += inferred.length;

        // Re-run collection auto-assignment
        const assigned = await classifyNodeIntoCollections(service, node.id, userId);
        collectionsTotal += assigned;

        processed++;
      } catch (e) {
        errors.push(`${node.id}: ${(e as Error).message}`);
      }
    }

    return jsonResponse({
      ok: true,
      scanned: nodes?.length ?? 0,
      processed,
      embedded,
      edges_created: edgesTotal,
      collections_assigned: collectionsTotal,
      errors: errors.slice(0, 5),
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[Mesh] reprocess-all error', e);
    return errorResponse('internal_error', 500, (e as Error).message);
  }
});
