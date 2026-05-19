/**
 * POST /functions/v1/backfill-hierarchy
 *
 * Walks the current user's existing nodes (most recent first) and runs the
 * hierarchy pipeline only:
 *   - ensures a canonical "page" node per source_url and links snippets via
 *     belongs_to_page,
 *   - wires navigated_from when the node carries a referrer or previous_url,
 *   - links same-session captures.
 *
 * This is the cheap, idempotent path to retrofit memories captured before
 * the hierarchy feature shipped. It does NOT re-run NER / embedding /
 * LLM link extraction — that's what /reprocess-all is for.
 *
 * Auth: user JWT (RLS scopes everything to auth.uid()).
 * Cost: one DB scan per batch; no LLM calls.
 *
 * Returns { scanned, pages_linked, nav_linked, sessions_linked, errors }.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { buildHierarchyEdges } from '../_shared/hierarchy.ts';
import { readExtracted, fallbackExtractedFromContent } from '../_shared/extracted.ts';

const DEFAULT_BATCH = 200;

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    const { userId } = await requireUser(req);
    const body = await parseJsonBody<{ limit?: number; offset?: number }>(req).catch(() => ({}));
    const limit = Math.min(Math.max(body.limit ?? DEFAULT_BATCH, 1), 500);
    const offset = Math.max(body.offset ?? 0, 0);

    const service = createServiceClient();

    // Pull a batch ordered oldest-first so navigated_from chains the right way:
    // earlier captures become potential parents of later ones.
    const { data: nodes, error } = await service
      .from('context_nodes')
      .select(
        'id, content, source, source_url, source_app, metadata, node_type, tags',
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) return errorResponse('list_failed', 500, error);

    let pagesLinked = 0;
    let navLinked = 0;
    let sessionsLinked = 0;
    let pagesCreated = 0;
    const errors: string[] = [];

    for (const node of nodes ?? []) {
      try {
        // Skip the auto-page nodes — they ARE pages, no parent to find.
        if (node.node_type === 'page') continue;

        const extracted =
          readExtracted(node.metadata) ??
          fallbackExtractedFromContent(
            (node.content as string) ?? '',
            (node.source as string) ?? 'extension',
            (node.source_url as string | null) ?? null,
            (node.source_app as string | null) ?? null,
          );

        const result = await buildHierarchyEdges({
          service,
          userId,
          nodeId: node.id as string,
          node: {
            source_url: (node.source_url as string | null) ?? null,
            source_app: (node.source_app as string | null) ?? null,
            metadata: node.metadata as Record<string, unknown> | null,
            node_type: (node.node_type as string | null) ?? null,
          },
          extracted,
        });

        if (result.page_parent) {
          pagesLinked++;
          // We can't trivially tell here if the page node was created vs reused;
          // we count "linked" only.
        }
        if (result.nav_parent) navLinked++;
        sessionsLinked += result.session_links;
      } catch (e) {
        errors.push(`${node.id}: ${(e as Error).message}`);
        if (errors.length > 5) break;
      }
    }

    return jsonResponse({
      ok: true,
      scanned: nodes?.length ?? 0,
      pages_linked: pagesLinked,
      pages_created: pagesCreated,
      nav_linked: navLinked,
      sessions_linked: sessionsLinked,
      next_offset: (offset + (nodes?.length ?? 0)),
      done: (nodes?.length ?? 0) < limit,
      errors: errors.slice(0, 5),
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[Mesh] backfill-hierarchy error', e);
    return errorResponse('internal_error', 500, (e as Error).message);
  }
});
