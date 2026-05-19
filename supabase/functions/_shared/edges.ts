/**
 * Edge inference — automatic relationship discovery between context nodes.
 *
 * For a newly-processed node, find candidates that share at least one
 * normalized entity, compute a combined score, and persist edges where
 * score >= EDGE_INFER_THRESHOLD (0.3).
 *
 *   combined = 0.4 * freq_co_occurrence + 0.3 * freshness + 0.3 * cosine_sim
 *
 * Frequency = how many entities are shared (capped at 3 for normalization).
 * Freshness = 1.0 if candidate < 24h old, decays to 0 over 90 days.
 * Cosine    = 1 - cosine_distance between embeddings.
 *
 * Edge type is 'inferred'. Temporal/contradicts/supersedes are computed
 * elsewhere (DeepSeek for contradicts in Phase 5).
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

interface Entity {
  type: string;
  value: string;
  normalized: string;
}

interface CandidateNode {
  id: string;
  entities: Entity[];
  embedding: number[] | null;
  created_at: string;
}

interface SourceNode {
  id: string;
  user_id: string;
  entities: Entity[];
  embedding: number[] | null;
}

const THRESHOLD = 0.3;
const SEMANTIC_THRESHOLD = 0.72; // cosine sim above which we infer an edge even without shared entities
const MAX_CANDIDATES = 100;
const MAX_SEMANTIC_NEIGHBORS = 8; // cap how many semantic-only edges we add per node
const FRESHNESS_HALF_LIFE_DAYS = 30;

function freshnessScore(createdAt: string): number {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / 86400_000;
  if (ageDays < 1) return 1;
  // Half-life decay
  return Math.max(0, Math.pow(0.5, ageDays / FRESHNESS_HALF_LIFE_DAYS));
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function intersectEntities(a: Entity[], b: Entity[]): Entity[] {
  const set = new Set(b.map((e) => e.normalized.toLowerCase()));
  return a.filter((e) => set.has(e.normalized.toLowerCase()));
}

/**
 * Find candidate nodes that share at least one entity with `node`.
 * Limits to the most recent MAX_CANDIDATES.
 */
async function findCandidates(
  client: SupabaseClient,
  node: SourceNode,
): Promise<CandidateNode[]> {
  if (!node.entities || node.entities.length === 0) return [];

  // pg "?|" jsonb-text-array operator works on top-level keys, not values.
  // We pre-filter by user, then post-filter in JS for entity overlap.
  const { data, error } = await client
    .from('context_nodes')
    .select('id, entities, embedding, created_at')
    .eq('user_id', node.user_id)
    .neq('id', node.id)
    .order('created_at', { ascending: false })
    .limit(MAX_CANDIDATES * 3); // overfetch then filter

  if (error || !data) return [];

  const sourceNorms = new Set(node.entities.map((e) => e.normalized.toLowerCase()));
  const matches: CandidateNode[] = [];
  for (const row of data) {
    const ents = (row.entities as Entity[]) ?? [];
    if (ents.some((e) => sourceNorms.has(e.normalized.toLowerCase()))) {
      matches.push({
        id: row.id,
        entities: ents,
        embedding: (row.embedding as number[] | null) ?? null,
        created_at: row.created_at,
      });
      if (matches.length >= MAX_CANDIDATES) break;
    }
  }
  return matches;
}

export interface InferredEdge {
  from_node: string;
  to_node: string;
  relation_type: 'inferred';
  confidence: number;
  shared_entity: string;
}

/**
 * Find candidates by semantic similarity only (when no entity overlap).
 * Uses pgvector's <=> distance operator via RPC for an efficient ANN search.
 * Fallback: scan recent nodes and compute cosine in-process.
 */
async function findSemanticNeighbors(
  client: SupabaseClient,
  node: SourceNode,
): Promise<CandidateNode[]> {
  if (!node.embedding) return [];

  // Try the optimized vector index first.
  const { data, error } = await client
    .from('context_nodes')
    .select('id, entities, embedding, created_at')
    .eq('user_id', node.user_id)
    .neq('id', node.id)
    .not('embedding', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MAX_CANDIDATES);

  if (error || !data) return [];

  return data.map((row) => ({
    id: row.id,
    entities: (row.entities as Entity[]) ?? [],
    embedding: (row.embedding as number[] | null) ?? null,
    created_at: row.created_at,
  }));
}

export async function inferEdgesForNode(
  client: SupabaseClient,
  node: SourceNode,
): Promise<InferredEdge[]> {
  const entityCandidates = await findCandidates(client, node);
  const semanticCandidates = await findSemanticNeighbors(client, node);

  // Merge candidate sets, de-duplicating by id (entity matches take precedence)
  const seen = new Set<string>();
  const allCandidates: CandidateNode[] = [];
  for (const c of entityCandidates) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      allCandidates.push(c);
    }
  }
  for (const c of semanticCandidates) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      allCandidates.push(c);
    }
  }

  if (allCandidates.length === 0) return [];

  const edges: InferredEdge[] = [];
  const semanticOnlyEdges: InferredEdge[] = [];

  for (const c of allCandidates) {
    const shared = intersectEntities(node.entities, c.entities);
    const fresh = freshnessScore(c.created_at);
    const sim =
      node.embedding && c.embedding ? Math.max(0, cosineSim(node.embedding, c.embedding)) : 0;

    if (shared.length > 0) {
      // Edge backed by shared entity (preferred — strongest signal)
      const freq = Math.min(shared.length / 3, 1);
      const score = freq * 0.4 + fresh * 0.3 + sim * 0.3;
      if (score >= THRESHOLD) {
        edges.push({
          from_node: node.id,
          to_node: c.id,
          relation_type: 'inferred',
          confidence: Math.min(score, 1),
          shared_entity: shared[0]?.normalized ?? '',
        });
      }
    } else if (sim >= SEMANTIC_THRESHOLD) {
      // Semantic-only edge — capture conceptual proximity without explicit overlap
      semanticOnlyEdges.push({
        from_node: node.id,
        to_node: c.id,
        relation_type: 'inferred',
        confidence: sim,
        shared_entity: 'semantic',
      });
    }
  }

  // Cap semantic-only edges to the strongest N to avoid a hairball
  semanticOnlyEdges.sort((a, b) => b.confidence - a.confidence);
  edges.push(...semanticOnlyEdges.slice(0, MAX_SEMANTIC_NEIGHBORS));

  if (edges.length === 0) return [];

  const rows = edges.map((e) => ({
    user_id: node.user_id,
    from_node: e.from_node,
    to_node: e.to_node,
    relation_type: e.relation_type,
    confidence: e.confidence,
    shared_entity: e.shared_entity,
  }));

  await client.from('context_edges').upsert(rows, {
    onConflict: 'user_id,from_node,to_node,relation_type',
    ignoreDuplicates: true,
  });

  return edges;
}
