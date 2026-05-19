/**
 * Build the hierarchical & navigational edges for a freshly processed node:
 *
 *   - belongs_to_page : ensure a canonical "page" node exists for this
 *                       node's source_url, and link this node as its child.
 *                       If THIS node is itself the page (node_type='page'),
 *                       no parent is created — we use this node as the page.
 *
 *   - navigated_from  : if the user came from a URL we've already captured
 *                       a page node for, link the current page node to it.
 *
 *   - same_session    : link the current node to the most recent N captures
 *                       inside the same session_id, with low confidence.
 *
 * A node can have multiple parents (page + nav + session) and be the parent
 * of many children — exactly the recursive structure the user asked for.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import type { Extracted } from './extracted.ts';

const SAME_SESSION_MAX_LINKS = 6;
const SESSION_LOOKBACK_MIN = 25; // a bit larger than the extension's 20-min window

interface Ctx {
  service: SupabaseClient;
  userId: string;
  nodeId: string;
  node: {
    source_url: string | null;
    source_app: string | null;
    metadata: Record<string, unknown> | null;
    node_type: string | null;
  };
  extracted: Extracted;
}

interface NewEdge {
  user_id: string;
  from_node: string;
  to_node: string;
  relation_type:
    | 'belongs_to_page'
    | 'navigated_from'
    | 'same_session';
  confidence: number;
  shared_entity: string | null;
}

function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    // Strip fragment and trailing slash for stable identity.
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

/**
 * Get-or-create the canonical "page" node for a URL.
 * Returns the page node id, or null if we can't find a stable URL.
 */
async function ensurePageNode(ctx: Ctx, url: string | null): Promise<string | null> {
  const canonical = normalizeUrl(url);
  if (!canonical) return null;

  // If THIS node is itself a page capture of this URL, it IS the page node.
  if (ctx.node.node_type === 'page' && normalizeUrl(ctx.node.source_url) === canonical) {
    return ctx.nodeId;
  }

  // Look for an existing page node for this user + url.
  const { data: existing } = await ctx.service
    .from('context_nodes')
    .select('id')
    .eq('user_id', ctx.userId)
    .eq('source_url', canonical)
    .eq('node_type', 'page')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id;

  // None yet — create a lightweight page node. process-node will run its
  // own pipeline against this row in the next pass (cron / on next visit).
  const ex = ctx.extracted;
  const host = (() => {
    try { return new URL(canonical).hostname; } catch { return null; }
  })();
  const pageTitle = ex.title ?? canonical;
  const pageDesc = ex.description ?? null;

  // Build a deterministic fingerprint so concurrent captures upsert safely.
  const fpInput = `page|${canonical}`;
  const fp = await sha256Hex(fpInput);

  const { data: created, error } = await ctx.service
    .from('context_nodes')
    .upsert(
      {
        user_id: ctx.userId,
        source: 'extension',
        source_url: canonical,
        source_app: host,
        content: `[Page] ${pageTitle}`,
        summary: pageDesc,
        tags: ['page'],
        score: 0.5,
        fingerprint: fp,
        metadata: {
          captureType: 'auto-page',
          extracted: {
            node_type: 'page',
            title: pageTitle,
            description: pageDesc,
            author: ex.author,
            content: null,
            media_url: null,
            media_thumbnail: ex.media_thumbnail ?? null,
            lang: ex.lang,
            site_name: ex.site_name ?? host,
            published_at: ex.published_at,
            keywords: ex.keywords ?? [],
            actions: [],
            source_extracted_at: new Date().toISOString(),
            extraction_method: 'heuristic',
          },
        },
      },
      { onConflict: 'user_id,fingerprint', ignoreDuplicates: false },
    )
    .select('id')
    .single();
  if (error || !created) {
    console.warn('ensurePageNode upsert failed', error);
    return null;
  }
  return created.id;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function insertEdges(ctx: Ctx, edges: NewEdge[]): Promise<number> {
  if (edges.length === 0) return 0;
  // Filter self-edges defensively.
  const rows = edges.filter((e) => e.from_node !== e.to_node);
  if (rows.length === 0) return 0;
  const { error } = await ctx.service
    .from('context_edges')
    .upsert(rows, {
      onConflict: 'user_id,from_node,to_node,relation_type',
      ignoreDuplicates: true,
    });
  if (error) {
    console.warn('insertEdges failed', error);
    return 0;
  }
  return rows.length;
}

export async function buildHierarchyEdges(ctx: Ctx): Promise<{
  page_parent: string | null;
  nav_parent: string | null;
  session_links: number;
}> {
  const edges: NewEdge[] = [];

  // ----- belongs_to_page -----
  const pageNodeId = await ensurePageNode(ctx, ctx.node.source_url);
  let pageParent: string | null = null;
  if (pageNodeId && pageNodeId !== ctx.nodeId) {
    edges.push({
      user_id: ctx.userId,
      from_node: pageNodeId,
      to_node: ctx.nodeId,
      relation_type: 'belongs_to_page',
      confidence: 0.9,
      shared_entity: 'page',
    });
    pageParent = pageNodeId;
  }

  // ----- navigated_from -----
  // Wire the page node (or this node when it's itself a page) to whichever
  // page the user came from. We try the explicit referrerUrl first, then
  // fall back to the session's previous_url.
  const md = ctx.node.metadata ?? {};
  const referrerUrl =
    (md.referrerUrl as string | null | undefined) ??
    (md.previous_url as string | null | undefined) ??
    null;
  let navParent: string | null = null;
  const target = pageNodeId ?? ctx.nodeId;
  if (referrerUrl && normalizeUrl(referrerUrl) !== normalizeUrl(ctx.node.source_url)) {
    const parentPage = await ensurePageNode(
      { ...ctx, node: { ...ctx.node, source_url: referrerUrl, node_type: 'page' } },
      referrerUrl,
    );
    if (parentPage && parentPage !== target) {
      edges.push({
        user_id: ctx.userId,
        from_node: parentPage,
        to_node: target,
        relation_type: 'navigated_from',
        confidence: 0.7,
        shared_entity: null,
      });
      navParent = parentPage;
    }
  }

  // ----- same_session -----
  let sessionLinks = 0;
  const sessionId = md.session_id as string | undefined;
  if (sessionId) {
    const since = new Date(Date.now() - SESSION_LOOKBACK_MIN * 60_000).toISOString();
    const { data: peers } = await ctx.service
      .from('context_nodes')
      .select('id, metadata')
      .eq('user_id', ctx.userId)
      .neq('id', ctx.nodeId)
      .gt('created_at', since)
      .order('created_at', { ascending: false })
      .limit(40);
    const matchingPeers = (peers ?? [])
      .filter((p) => {
        const meta = p.metadata as Record<string, unknown> | null;
        return (meta?.session_id as string | undefined) === sessionId;
      })
      .slice(0, SAME_SESSION_MAX_LINKS);

    for (const p of matchingPeers) {
      edges.push({
        user_id: ctx.userId,
        from_node: p.id as string,
        to_node: ctx.nodeId,
        relation_type: 'same_session',
        confidence: 0.35,
        shared_entity: 'session',
      });
    }
    sessionLinks = matchingPeers.length;
  }

  await insertEdges(ctx, edges);

  return { page_parent: pageParent, nav_parent: navParent, session_links: sessionLinks };
}
