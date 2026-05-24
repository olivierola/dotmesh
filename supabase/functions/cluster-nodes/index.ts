/**
 * POST /functions/v1/cluster-nodes?k=8
 *
 * User-triggered semantic re-clustering. Loads every embedding the user
 * has, runs k-means on them, asks an LLM to label each cluster (1-3 word
 * theme), then materializes the result as auto-generated collections so
 * the graph & timeline naturally group by theme.
 *
 * Each cluster becomes a collection named "🎯 <theme>" (icon=🎯) with
 * is_default=false. Existing 🎯-clusters from a prior run are wiped first
 * so the operation is idempotent — the user always sees the *current* set.
 *
 * Cost: 1 LLM call per cluster (so 8 by default). No new embeddings.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';
import { deepseekReason } from '../_shared/ai.ts';

const CLUSTER_ICON = '🎯';
const CLUSTER_PREFIX = `${CLUSTER_ICON} `;

interface NodeRow {
  id: string;
  content: string | null;
  summary: string | null;
  embedding: number[] | string | null; // pgvector returns string in some clients
  metadata: Record<string, unknown> | null;
}

function parseEmbedding(raw: number[] | string | null): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  // pgvector text form: "[0.1, 0.2, ...]"
  try {
    return JSON.parse(raw as string) as number[];
  } catch {
    return null;
  }
}

function l2norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function normalize(v: number[]): number[] {
  const n = l2norm(v);
  if (n === 0) return v;
  return v.map((x) => x / n);
}

function cosineDistance(a: number[], b: number[]): number {
  // Vectors are unit-normalized so cos = dot.
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return 1 - dot;
}

function meanVector(vs: number[][], dim: number): number[] {
  const out = new Array<number>(dim).fill(0);
  for (const v of vs) {
    for (let i = 0; i < dim; i++) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
  }
  for (let i = 0; i < dim; i++) out[i] = (out[i] ?? 0) / Math.max(1, vs.length);
  return out;
}

/** Deterministic seeded picker so the same data → same clusters. */
function seededIndex(n: number, seed: number): number {
  // xorshift
  let x = seed | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return Math.abs(x) % n;
}

/** k-means++ seeding: choose centroids spread across the data. */
function kmeansPlusPlusInit(vectors: number[][], k: number, seed: number): number[][] {
  const dim = vectors[0]!.length;
  const centroids: number[][] = [];
  // First centroid: deterministic pick.
  centroids.push(vectors[seededIndex(vectors.length, seed)]!.slice());

  for (let c = 1; c < k; c++) {
    // For each point, distance to its nearest existing centroid.
    const d2: number[] = vectors.map((v) => {
      let best = Infinity;
      for (const cen of centroids) {
        const d = cosineDistance(v, cen);
        if (d < best) best = d;
      }
      return best * best;
    });
    const total = d2.reduce((s, x) => s + x, 0);
    if (total <= 0) {
      // Degenerate: just pick a fresh one
      centroids.push(vectors[seededIndex(vectors.length, seed + c)]!.slice());
      continue;
    }
    // Weighted pick with a deterministic threshold.
    const threshold = ((seed + c * 1103515245) % 1_000_000) / 1_000_000 * total;
    let acc = 0;
    let picked = vectors.length - 1;
    for (let i = 0; i < vectors.length; i++) {
      acc += d2[i]!;
      if (acc >= threshold) {
        picked = i;
        break;
      }
    }
    centroids.push(vectors[picked]!.slice());
    void dim;
  }
  return centroids;
}

function kmeans(
  vectors: number[][],
  k: number,
  maxIter = 30,
): { assignments: number[]; centroids: number[][] } {
  if (vectors.length === 0) return { assignments: [], centroids: [] };
  const dim = vectors[0]!.length;
  const effectiveK = Math.min(k, vectors.length);
  let centroids = kmeansPlusPlusInit(vectors, effectiveK, 42);

  const assignments = new Array<number>(vectors.length).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let moved = 0;
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i]!;
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = cosineDistance(v, centroids[c]!);
        if (d < bestD) {
          bestD = d;
          bestC = c;
        }
      }
      if (assignments[i] !== bestC) {
        assignments[i] = bestC;
        moved++;
      }
    }
    if (moved === 0) break;
    // Recompute centroids
    const groups: number[][][] = Array.from({ length: centroids.length }, () => []);
    for (let i = 0; i < vectors.length; i++) {
      groups[assignments[i]!]!.push(vectors[i]!);
    }
    centroids = groups.map((g, c) => {
      if (g.length === 0) return centroids[c]!; // empty cluster → keep prior centroid
      return normalize(meanVector(g, dim));
    });
  }
  return { assignments, centroids };
}

async function labelCluster(
  service: ReturnType<typeof createServiceClient>,
  nodeIds: string[],
): Promise<string> {
  // Sample up to 8 nodes' summaries to feed the LLM.
  const sample = nodeIds.slice(0, 8);
  const { data: rows } = await service
    .from('context_nodes')
    .select('summary, content, metadata')
    .in('id', sample);
  const lines: string[] = [];
  for (const r of rows ?? []) {
    const md = (r.metadata as Record<string, unknown> | null) ?? {};
    const ex = (md.extracted as { title?: string } | undefined) ?? {};
    const head =
      (ex.title as string | undefined) ??
      (r.summary as string | null) ??
      ((r.content as string | null)?.slice(0, 120) ?? '');
    if (head) lines.push(`- ${head}`);
  }
  if (lines.length === 0) return 'Unlabeled';

  try {
    const text = await deepseekReason({
      systemPrompt:
        'You produce a short thematic label (1 to 3 words, Title Case, no punctuation, no quotes) for a cluster of related memories. Return only the label.',
      userPrompt: `Cluster sample:\n${lines.join('\n')}\n\nLabel:`,
      maxTokens: 20,
    });
    const cleaned = (text ?? '').replace(/["'`.]/g, '').trim().split('\n')[0]!.slice(0, 40);
    return cleaned || 'Cluster';
  } catch {
    return 'Cluster';
  }
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    const { userId, client } = await requireUser(req);
    const url = new URL(req.url);
    const kRaw = Number(url.searchParams.get('k') ?? 8);
    const k = Number.isFinite(kRaw) ? Math.max(2, Math.min(20, kRaw)) : 8;

    // 1. Load embeddings (cap to 1000 nodes — k-means cost is fine, the
    //    LLM labelling pass is the budget watcher).
    const { data: rows, error } = await client
      .from('context_nodes')
      .select('id, content, summary, embedding, metadata')
      .not('embedding', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1000);
    if (error) return errorResponse('list_failed', 500, error);

    const typed = (rows ?? []) as NodeRow[];
    const parsed: Array<{ id: string; vec: number[] }> = [];
    for (const r of typed) {
      const v = parseEmbedding(r.embedding);
      if (v && v.length > 0) parsed.push({ id: r.id, vec: normalize(v) });
    }
    if (parsed.length < k * 2) {
      return jsonResponse({
        ok: false,
        reason: 'not_enough_embedded_nodes',
        node_count: parsed.length,
        needed: k * 2,
      });
    }

    // 2. Run k-means.
    const { assignments } = kmeans(parsed.map((p) => p.vec), k);
    const clusters = new Map<number, string[]>();
    for (let i = 0; i < parsed.length; i++) {
      const c = assignments[i]!;
      const arr = clusters.get(c) ?? [];
      arr.push(parsed[i]!.id);
      clusters.set(c, arr);
    }

    const service = createServiceClient();

    // 3. Wipe previous 🎯-clusters so the operation is idempotent.
    const { data: oldCollections } = await service
      .from('collections')
      .select('id, name')
      .eq('user_id', userId)
      .like('name', `${CLUSTER_PREFIX}%`);
    const oldIds = (oldCollections ?? []).map((c) => c.id as string);
    if (oldIds.length > 0) {
      await service.from('node_collections').delete().in('collection_id', oldIds);
      await service.from('collections').delete().in('id', oldIds);
    }

    // 4. For each cluster, label + create collection + assign members.
    const created: Array<{ id: string; name: string; size: number }> = [];
    for (const [cid, members] of clusters.entries()) {
      if (members.length < 2) continue; // skip singletons
      const label = await labelCluster(service, members);
      const name = `${CLUSTER_PREFIX}${label}`;
      const insertCol = await service
        .from('collections')
        .insert({
          user_id: userId,
          name,
          description: `Auto-clustered group of ${members.length} related memories.`,
          icon: CLUSTER_ICON,
          color: null,
          filter: {},
          is_default: false,
          rule_prompt: null,
        })
        .select('id')
        .single();
      if (insertCol.error || !insertCol.data) continue;
      const collectionId = insertCol.data.id as string;

      // Insert node_collections rows in bulk
      const inserts = members.map((nid) => ({
        node_id: nid,
        collection_id: collectionId,
        user_id: userId,
        source: 'auto-cluster',
      }));
      await service.from('node_collections').insert(inserts);
      created.push({ id: collectionId, name, size: members.length });
      void cid;
    }

    return jsonResponse({
      ok: true,
      k,
      node_count: parsed.length,
      clusters_created: created.length,
      old_wiped: oldIds.length,
      clusters: created,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('cluster-nodes error', e);
    return errorResponse('internal_error', 500, (e as Error).message);
  }
});
