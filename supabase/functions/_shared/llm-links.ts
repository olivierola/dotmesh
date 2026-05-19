/**
 * LLM-declared semantic edges.
 *
 * Once entity-based + cosine-based inference has run, we take the new node
 * together with its top-K semantic neighbours and ask a small LLM to
 * declare *named* relationships. The model can pick among:
 *
 *   - mentions     : node A explicitly references the subject of B
 *   - extends      : A elaborates / continues / builds on B
 *   - cites        : A quotes or links to B
 *   - contradicts  : A says the opposite of B
 *
 * Output is heavily constrained and the result is filtered to (a) only IDs
 * the model was given, and (b) at most one edge of each type per neighbour.
 *
 * This sits BELOW the existing inferred/semantic edges — it doesn't replace
 * them, it adds typed connections on top.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { groqChat } from './ai.ts';
import type { Extracted } from './extracted.ts';

const MAX_NEIGHBOURS = 10;
const MIN_CONTENT_FOR_LLM = 80;

type RelType = 'mentions' | 'extends' | 'cites' | 'contradicts';
const VALID_RELS: RelType[] = ['mentions', 'extends', 'cites', 'contradicts'];

interface NeighbourSummary {
  id: string;
  title: string;
  description: string;
  url: string | null;
}

interface Ctx {
  service: SupabaseClient;
  userId: string;
  nodeId: string;
  extracted: Extracted;
  rawContent: string;
  /** Pre-existing inferred edges from the entity/cosine pass — used to
   *  surface candidate neighbours without re-querying. */
  candidateIds: string[];
}

function summariseNeighbour(row: {
  id: string;
  content: string;
  summary: string | null;
  source_url: string | null;
  metadata: Record<string, unknown> | null;
}): NeighbourSummary {
  const ex = row.metadata?.extracted as
    | { title?: string | null; description?: string | null }
    | undefined;
  const title = ex?.title ?? row.summary ?? row.content.slice(0, 120);
  const description = ex?.description ?? row.summary ?? row.content.slice(0, 200);
  return {
    id: row.id,
    title: (title ?? '').slice(0, 200),
    description: (description ?? '').slice(0, 300),
    url: row.source_url,
  };
}

export async function declareLLMLinks(ctx: Ctx): Promise<{ added: number; types: Record<string, number> }> {
  if (ctx.candidateIds.length === 0) return { added: 0, types: {} };
  if (
    (ctx.extracted.content?.length ?? 0) + (ctx.rawContent?.length ?? 0) <
    MIN_CONTENT_FOR_LLM
  ) {
    return { added: 0, types: {} };
  }

  // Fetch up to MAX_NEIGHBOURS candidate rows
  const { data: rows } = await ctx.service
    .from('context_nodes')
    .select('id, content, summary, source_url, metadata')
    .in('id', ctx.candidateIds.slice(0, MAX_NEIGHBOURS));
  const neighbours = (rows ?? []).map(summariseNeighbour);
  if (neighbours.length === 0) return { added: 0, types: {} };

  const newSummary = `
Title:       ${ctx.extracted.title ?? '(none)'}
Author:      ${ctx.extracted.author ?? '(none)'}
Description: ${ctx.extracted.description ?? '(none)'}
URL:         ${ctx.extracted.media_url ?? '(none)'}
Body:
${(ctx.extracted.content ?? ctx.rawContent).slice(0, 1500)}
`.trim();

  const neighbourBlock = neighbours
    .map((n, i) => `${i + 1}. id=${n.id} | "${n.title}"\n   ${n.description}`)
    .join('\n');

  const sys =
    'You analyse a freshly captured note against neighbours from the user\'s memory ' +
    'and return STRICT JSON only — no prose, no markdown. ' +
    'You declare typed relationships when the connection is OBVIOUS — never speculate.';

  const user = `New note (id=NEW):
${newSummary}

Neighbours (each has an id you must use literally):
${neighbourBlock}

For each neighbour, decide if there is a clear, factual relationship.
Allowed types:
  - "mentions"    : the new note explicitly references the neighbour's subject
  - "extends"     : the new note elaborates / continues / develops the neighbour
  - "cites"       : the new note quotes or links to the neighbour (use only if the URL or text overlap is unambiguous)
  - "contradicts" : the new note states something incompatible with the neighbour

Return JSON of the form:
{ "edges": [ { "neighbour_id": "<id>", "type": "<one of the four>", "reason": "<10-15 words>" } ] }

Constraints:
- Skip neighbours where the link is weak or speculative. Better to return [] than to invent.
- Each (neighbour_id, type) pair must appear at most once.
- Max 6 edges total.`;

  const result = await groqChat({
    model: 'llama-3.1-8b-instant',
    systemPrompt: sys,
    userPrompt: user,
    jsonMode: true,
    maxTokens: 500,
    feature: 'llm-link-extractor',
  });

  if (!result) return { added: 0, types: {} };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result) as Record<string, unknown>;
  } catch {
    return { added: 0, types: {} };
  }
  if (!Array.isArray(parsed.edges)) return { added: 0, types: {} };

  const allowed = new Set(neighbours.map((n) => n.id));
  const dedup = new Set<string>();
  const edges: Array<{
    user_id: string;
    from_node: string;
    to_node: string;
    relation_type: RelType;
    confidence: number;
    shared_entity: string;
    note: string;
  }> = [];

  for (const raw of parsed.edges as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const nid = typeof e.neighbour_id === 'string' ? e.neighbour_id : null;
    const type = typeof e.type === 'string' ? (e.type as RelType) : null;
    const reason = typeof e.reason === 'string' ? e.reason.slice(0, 200) : '';
    if (!nid || !type) continue;
    if (!allowed.has(nid)) continue;
    if (!VALID_RELS.includes(type)) continue;
    const key = `${nid}|${type}`;
    if (dedup.has(key)) continue;
    dedup.add(key);

    edges.push({
      user_id: ctx.userId,
      from_node: ctx.nodeId,
      to_node: nid,
      relation_type: type,
      confidence: type === 'contradicts' ? 0.6 : 0.75,
      shared_entity: type,
      note: reason,
    });
    if (edges.length >= 6) break;
  }

  if (edges.length === 0) return { added: 0, types: {} };

  const { error } = await ctx.service
    .from('context_edges')
    .upsert(edges, {
      onConflict: 'user_id,from_node,to_node,relation_type',
      ignoreDuplicates: true,
    });
  if (error) {
    console.warn('declareLLMLinks insert failed', error);
    return { added: 0, types: {} };
  }

  const types: Record<string, number> = {};
  for (const e of edges) types[e.relation_type] = (types[e.relation_type] ?? 0) + 1;
  return { added: edges.length, types };
}
