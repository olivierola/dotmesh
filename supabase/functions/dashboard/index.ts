/**
 * GET /functions/v1/dashboard
 * Returns the aggregated snapshot displayed on /dashboard.
 *
 * Pulls from:
 *   - context_nodes  → totals, by_source, recent_nodes
 *   - context_edges  → edge total
 *   - injections     → recent_injections, by_agent breakdown
 *   - usage_metrics  → daily series (30 days)
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';

interface DailyRow {
  date: string;
  nodes_created: number;
  pulls_count: number;
  injections_count: number;
}

interface NodeRow {
  id: string;
  source: string;
  source_url: string | null;
  source_app: string | null;
  content: string;
  summary: string | null;
  entities: Array<{ type: string; value: string; normalized: string }>;
  tags: string[];
  score: number | null;
  pinned: boolean;
  created_at: string;
}

interface InjectionRow {
  id: string;
  target_agent: string;
  query_excerpt: string | null;
  node_ids: string[];
  user_accepted: boolean | null;
  created_at: string;
}

function startOfDay(d: Date): string {
  return new Date(d).toISOString().split('T')[0]!;
}

function todayUtc(): string {
  return startOfDay(new Date());
}

function buildDailySeries(rows: DailyRow[], days: number): Array<{
  date: string;
  captures: number;
  injections: number;
  pulls: number;
}> {
  const map = new Map<string, DailyRow>();
  rows.forEach((r) => map.set(r.date, r));
  const out: Array<{ date: string; captures: number; injections: number; pulls: number }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000);
    const key = startOfDay(d);
    const row = map.get(key);
    out.push({
      date: key,
      captures: row?.nodes_created ?? 0,
      injections: row?.injections_count ?? 0,
      pulls: row?.pulls_count ?? 0,
    });
  }
  return out;
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'GET') return errorResponse('method_not_allowed', 405);

  try {
    const { client } = await requireUser(req);

    const sinceWeek = new Date(Date.now() - 7 * 86400_000).toISOString();
    const since30 = new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0];

    const [
      nodesCountRes,
      edgesCountRes,
      todayMetricsRes,
      weekMetricsRes,
      avgScoreRes,
      sourcesRes,
      recentNodesRes,
      recentInjRes,
      agentBreakdownRes,
      dailyRes,
    ] = await Promise.all([
      client.from('context_nodes').select('id', { count: 'exact', head: true }),
      client.from('context_edges').select('id', { count: 'exact', head: true }),
      client
        .from('usage_metrics')
        .select('nodes_created, pulls_count, injections_count')
        .eq('date', todayUtc())
        .maybeSingle(),
      client
        .from('usage_metrics')
        .select('nodes_created, pulls_count, injections_count')
        .gte('date', startOfDay(new Date(Date.now() - 6 * 86400_000))),
      client
        .from('context_nodes')
        .select('score')
        .not('score', 'is', null)
        .order('created_at', { ascending: false })
        .limit(100),
      client
        .from('context_nodes')
        .select('source')
        .order('created_at', { ascending: false })
        .limit(500),
      client
        .from('context_nodes')
        .select(
          'id, source, source_url, source_app, content, summary, entities, tags, score, pinned, created_at',
        )
        .order('created_at', { ascending: false })
        .limit(5),
      client
        .from('injections')
        .select('id, target_agent, query_excerpt, node_ids, user_accepted, created_at')
        .order('created_at', { ascending: false })
        .limit(5),
      client
        .from('injections')
        .select('target_agent, user_accepted, created_at')
        .gt('created_at', sinceWeek)
        .limit(500),
      client
        .from('usage_metrics')
        .select('date, nodes_created, pulls_count, injections_count')
        .gte('date', since30)
        .order('date', { ascending: true }),
    ]);

    const nodesTotal = nodesCountRes.count ?? 0;
    const edgesTotal = edgesCountRes.count ?? 0;
    const today = todayMetricsRes.data ?? { nodes_created: 0, pulls_count: 0, injections_count: 0 };
    const weekRows = (weekMetricsRes.data ?? []) as Array<{
      nodes_created: number;
      pulls_count: number;
      injections_count: number;
    }>;
    const capturesWeek = weekRows.reduce((a, r) => a + (r.nodes_created ?? 0), 0);
    const injectionsWeek = weekRows.reduce((a, r) => a + (r.injections_count ?? 0), 0);

    const scores = (avgScoreRes.data ?? []) as Array<{ score: number }>;
    const avgScore = scores.length
      ? scores.reduce((a, r) => a + (r.score ?? 0), 0) / scores.length
      : 0;

    const sourceCounts: Record<string, number> = {};
    for (const row of (sourcesRes.data ?? []) as Array<{ source: string }>) {
      sourceCounts[row.source] = (sourceCounts[row.source] ?? 0) + 1;
    }
    const bySource = Object.entries(sourceCounts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    const agentRows = (agentBreakdownRes.data ?? []) as Array<{
      target_agent: string;
      user_accepted: boolean | null;
    }>;
    const agentAgg: Record<string, { injections: number; accepted: number }> = {};
    for (const row of agentRows) {
      const k = row.target_agent;
      const cur = agentAgg[k] ?? { injections: 0, accepted: 0 };
      cur.injections++;
      if (row.user_accepted) cur.accepted++;
      agentAgg[k] = cur;
    }
    const byAgent = Object.entries(agentAgg)
      .map(([agent, v]) => ({
        agent,
        injections: v.injections,
        accept_rate: v.injections > 0 ? v.accepted / v.injections : 0,
      }))
      .sort((a, b) => b.injections - a.injections)
      .slice(0, 8);

    const dailySeries = buildDailySeries(
      ((dailyRes.data ?? []) as DailyRow[]).map((r) => ({
        date: r.date,
        nodes_created: r.nodes_created ?? 0,
        pulls_count: r.pulls_count ?? 0,
        injections_count: r.injections_count ?? 0,
      })),
      30,
    );

    return jsonResponse({
      totals: {
        nodes: nodesTotal,
        edges: edgesTotal,
        captures_today: today.nodes_created ?? 0,
        captures_week: capturesWeek,
        injections_today: today.injections_count ?? 0,
        injections_week: injectionsWeek,
        pulls_today: today.pulls_count ?? 0,
        avg_score: avgScore,
      },
      daily: dailySeries,
      by_source: bySource,
      by_agent: byAgent,
      recent_nodes: (recentNodesRes.data ?? []) as NodeRow[],
      recent_injections: ((recentInjRes.data ?? []) as InjectionRow[]).map((i) => ({
        id: i.id,
        target_agent: i.target_agent,
        query_excerpt: i.query_excerpt ?? '',
        nodes_used: i.node_ids.length,
        accepted: i.user_accepted ?? false,
        created_at: i.created_at,
      })),
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('dashboard error', e);
    return errorResponse('internal_error', 500);
  }
});
