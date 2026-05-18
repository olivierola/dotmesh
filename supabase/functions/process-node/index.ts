/**
 * POST /functions/v1/process-node
 *
 * Async processor for a freshly created node:
 *   - Run NER (Groq llama-8b)
 *   - Generate summary (Groq llama-70b)
 *   - Compute embedding (Jina v3)
 *   - Update node row
 *   - TODO Phase 1: trigger edge inference
 *
 * Invoked by the `nodes` function fire-and-forget OR by a Realtime trigger.
 * Authenticated via service role (no end-user JWT).
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { extractEntities, summarize, jinaEmbed } from '../_shared/ai.ts';
import { inferEdgesForNode } from '../_shared/edges.ts';
import { classifyNodeIntoCollections } from '../_shared/collections-assigner.ts';

interface ProcessInput {
  node_id: string;
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  // Service-role auth check
  const auth = req.headers.get('Authorization') ?? '';
  const expected = `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`;
  if (auth !== expected) return errorResponse('forbidden', 403);

  try {
    const { node_id } = await parseJsonBody<ProcessInput>(req);
    if (!node_id) return errorResponse('node_id_required', 400);

    const client = createServiceClient();
    const { data: node, error } = await client
      .from('context_nodes')
      .select('id, user_id, content, summary, embedding, entities')
      .eq('id', node_id)
      .maybeSingle();

    if (error || !node) return errorResponse('node_not_found', 404);

    // Run NER + summary + embedding concurrently
    const [entities, summary, embedding] = await Promise.all([
      extractEntities(node.content),
      node.summary ? Promise.resolve(node.summary) : summarize(node.content),
      node.embedding ? Promise.resolve(null) : jinaEmbed(node.summary ?? node.content),
    ]);

    const updates: Record<string, unknown> = { entities };
    if (summary) updates.summary = summary;
    if (embedding) updates.embedding = embedding;

    const { error: updateErr } = await client
      .from('context_nodes')
      .update(updates)
      .eq('id', node_id);

    if (updateErr) {
      console.error('processor update failed', updateErr);
      return errorResponse('update_failed', 500, updateErr);
    }

    // Edge inference (uses the freshly enriched node)
    let edgesCreated = 0;
    try {
      const inferred = await inferEdgesForNode(client, {
        id: node.id,
        user_id: node.user_id,
        entities,
        embedding: embedding ?? (node.embedding as number[] | null),
      });
      edgesCreated = inferred.length;
    } catch (e) {
      console.warn('edge inference failed (non-fatal)', e);
    }

    // Collection assignment (deterministic, no LLM call — uses SQL helper).
    let collectionsAssigned = 0;
    try {
      collectionsAssigned = await classifyNodeIntoCollections(
        client,
        node.id,
        node.user_id,
      );
    } catch (e) {
      console.warn('collection assignment failed (non-fatal)', e);
    }

    return jsonResponse({
      ok: true,
      node_id,
      entities_count: entities.length,
      edges_created: edgesCreated,
      collections_assigned: collectionsAssigned,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('processor error', e);
    return errorResponse('internal_error', 500);
  }
});
