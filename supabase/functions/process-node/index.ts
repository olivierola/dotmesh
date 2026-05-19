/**
 * POST /functions/v1/process-node
 *
 * Async processor for a freshly created node. Pipeline:
 *
 *   1. Load row (content, summary, metadata, etc.)
 *   2. Ensure metadata.extracted exists (build a minimal one if missing).
 *   3. Run heuristic→LLM completion of extracted (fill null title/author/...).
 *   4. NER + summary + Jina embedding (concurrent).
 *   5. Persist updates (entities, summary, embedding, metadata.extracted).
 *   6. Edge inference.
 *   7. Collection assignment:
 *        a) Deterministic filter-based classifier (existing).
 *        b) LLM-based classifier when (a) only yielded Inbox.
 *
 * Auth: service-role bearer only (this is invoked by `nodes` fire-and-forget).
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient, assertServiceRole } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { extractEntities, summarize, jinaEmbed } from '../_shared/ai.ts';
import { inferEdgesForNode } from '../_shared/edges.ts';
import { classifyNodeIntoCollections } from '../_shared/collections-assigner.ts';
import { llmAssignCollections } from '../_shared/collections-llm-assigner.ts';
import {
  readExtracted,
  fallbackExtractedFromContent,
  completeExtractedWithLLM,
} from '../_shared/extracted.ts';
import { buildHierarchyEdges } from '../_shared/hierarchy.ts';
import { declareLLMLinks } from '../_shared/llm-links.ts';

interface ProcessInput {
  node_id: string;
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    assertServiceRole(req);
  } catch (e) {
    if (e instanceof Response) return e;
    return errorResponse('forbidden', 403);
  }

  try {
    const { node_id } = await parseJsonBody<ProcessInput>(req);
    if (!node_id) return errorResponse('node_id_required', 400);

    const client = createServiceClient();
    const { data: node, error } = await client
      .from('context_nodes')
      .select(
        'id, user_id, content, summary, embedding, entities, metadata, source, source_url, source_app, tags',
      )
      .eq('id', node_id)
      .maybeSingle();

    if (error || !node) return errorResponse('node_not_found', 404);

    // ---- Step 1: extracted JSON ---------------------------------------------
    const initial =
      readExtracted(node.metadata) ??
      fallbackExtractedFromContent(
        node.content ?? '',
        node.source ?? 'extension',
        node.source_url,
        node.source_app,
      );

    const extracted = await completeExtractedWithLLM(
      initial,
      node.content ?? '',
      node.source_url,
    );

    // ---- Step 2: NER + summary + embedding (concurrent) ---------------------
    const summarySource = extracted.description ?? extracted.title ?? node.content ?? '';
    const embedSource = extracted.title
      ? `${extracted.title}\n${extracted.description ?? ''}\n${extracted.content ?? node.content ?? ''}`
      : (node.content ?? '');

    const [entities, summary, embedding] = await Promise.all([
      extractEntities(extracted.content ?? node.content ?? ''),
      node.summary
        ? Promise.resolve(node.summary)
        : extracted.description
          ? Promise.resolve(extracted.description)
          : summarize(summarySource),
      node.embedding ? Promise.resolve(null) : jinaEmbed(embedSource),
    ]);

    // ---- Step 3: persist ----------------------------------------------------
    const mergedMetadata = {
      ...(node.metadata as Record<string, unknown> | null ?? {}),
      extracted,
    };

    const updates: Record<string, unknown> = {
      entities,
      metadata: mergedMetadata,
    };
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

    // ---- Step 4a: classic edge inference (entity + semantic) --------------
    let edgesCreated = 0;
    let inferredIds: string[] = [];
    try {
      const inferred = await inferEdgesForNode(client, {
        id: node.id,
        user_id: node.user_id,
        entities,
        embedding: embedding ?? (node.embedding as number[] | null),
      });
      edgesCreated = inferred.length;
      inferredIds = inferred.map((e) => e.to_node);
    } catch (e) {
      console.warn('edge inference failed (non-fatal)', e);
    }

    // ---- Step 4b: hierarchical edges (page / nav / session) ----------------
    let pageParent: string | null = null;
    let navParent: string | null = null;
    let sessionLinks = 0;
    try {
      const r = await buildHierarchyEdges({
        service: client,
        userId: node.user_id,
        nodeId: node.id,
        node: {
          source_url: node.source_url as string | null,
          source_app: node.source_app as string | null,
          metadata: mergedMetadata,
          node_type: extracted.node_type,
        },
        extracted,
      });
      pageParent = r.page_parent;
      navParent = r.nav_parent;
      sessionLinks = r.session_links;
    } catch (e) {
      console.warn('hierarchy edges failed (non-fatal)', e);
    }

    // ---- Step 4c: LLM-declared semantic links -----------------------------
    let llmLinks = { added: 0, types: {} as Record<string, number> };
    try {
      llmLinks = await declareLLMLinks({
        service: client,
        userId: node.user_id,
        nodeId: node.id,
        extracted,
        rawContent: node.content ?? '',
        candidateIds: inferredIds,
      });
    } catch (e) {
      console.warn('llm link extractor failed (non-fatal)', e);
    }

    // ---- Step 5a: deterministic collection classifier -----------------------
    let collectionsAssigned = 0;
    let deterministicMatchedNonDefault = false;
    try {
      collectionsAssigned = await classifyNodeIntoCollections(
        client,
        node.id,
        node.user_id,
      );
      // Did the classifier attach anything besides Inbox? If so, skip LLM.
      if (collectionsAssigned > 0) {
        const { data: assigned } = await client
          .from('node_collections')
          .select('collection_id, collections!inner(is_default)')
          .eq('node_id', node.id);
        deterministicMatchedNonDefault = (assigned ?? []).some(
          (row) => (row as unknown as { collections: { is_default: boolean } }).collections.is_default === false,
        );
      }
    } catch (e) {
      console.warn('collection assignment failed (non-fatal)', e);
    }

    // ---- Step 5b: LLM collection assigner ----------------------------------
    let llmCollectionsAdded = 0;
    let createdCollectionId: string | null = null;
    try {
      const r = await llmAssignCollections(client, {
        nodeId: node.id,
        userId: node.user_id,
        extracted,
        rawContent: node.content ?? '',
        tags: (node.tags as string[] | null) ?? [],
        deterministicMatchedNonDefault,
      });
      llmCollectionsAdded = r.added;
      createdCollectionId = r.created_collection;
    } catch (e) {
      console.warn('llm collection assignment failed (non-fatal)', e);
    }

    return jsonResponse({
      ok: true,
      node_id,
      node_type: extracted.node_type,
      entities_count: entities.length,
      edges_created: edgesCreated,
      page_parent: pageParent,
      nav_parent: navParent,
      session_links: sessionLinks,
      llm_links: llmLinks,
      collections_assigned: collectionsAssigned + llmCollectionsAdded,
      collection_created: createdCollectionId,
      extraction_method: extracted.extraction_method,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('processor error', e);
    return errorResponse('internal_error', 500);
  }
});
