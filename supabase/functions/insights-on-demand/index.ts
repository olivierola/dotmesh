/**
 * POST /functions/v1/insights-on-demand
 *
 * User-triggered version of /insights-generate. Same aggregation logic, but:
 *   - authenticated via the calling user's JWT (no service-role check)
 *   - accepts a `days` query param (1..90, default 7)
 *   - returns the insight JSON directly instead of upserting weekly_insights
 *
 * Built so the Assistant page can ask for a fresh digest on demand without
 * waiting for the Monday cron job.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';
import { deepseekReason } from '../_shared/ai.ts';

interface Entity {
  type: string;
  value: string;
  normalized: string;
}

interface ExtractedSnippet {
  author?: string | null;
  site_name?: string | null;
  keywords?: string[];
  title?: string | null;
}

interface Node {
  id: string;
  content: string;
  summary: string | null;
  entities: Entity[];
  tags: string[];
  ttl_at: string | null;
  created_at: string;
  source_app: string | null;
  node_type: string | null;
  metadata: { extracted?: ExtractedSnippet } | null;
}

function topN<T>(
  items: T[],
  keyFn: (t: T) => string | null | undefined,
  n: number,
): Array<{ label: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    const key = k.trim();
    if (!key) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    const { client } = await requireUser(req);

    const url = new URL(req.url);
    const daysRaw = Number(url.searchParams.get('days') ?? 7);
    const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(90, daysRaw)) : 7;
    const since = new Date(Date.now() - days * 86400_000).toISOString();

    const { data: nodes, error } = await client
      .from('context_nodes')
      .select(
        'id, content, summary, entities, tags, ttl_at, created_at, source_app, node_type, metadata',
      )
      .gt('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return errorResponse('fetch_failed', 500, error);

    const typed = (nodes ?? []) as Node[];
    if (typed.length === 0) {
      return jsonResponse({
        ok: true,
        days,
        node_count: 0,
        insight: null,
        note: 'no captures in this window',
      });
    }

    const topicEntities = typed.flatMap((n) =>
      (n.entities ?? []).filter((e) => e.type === 'TOPIC' || e.type === 'PROJECT'),
    );
    const themes = topN(topicEntities, (e) => e.value, 5);

    const personEntities = typed.flatMap((n) =>
      (n.entities ?? []).filter((e) => e.type === 'PERSON'),
    );
    const people = topN(personEntities, (e) => e.value, 8);

    const top_authors = topN(typed, (n) => n.metadata?.extracted?.author ?? null, 8);
    const top_sites = topN(
      typed,
      (n) => n.metadata?.extracted?.site_name ?? n.source_app ?? null,
      8,
    );
    const type_breakdown = topN(typed, (n) => n.node_type ?? 'text', 8);
    const allKeywords = typed.flatMap((n) => n.metadata?.extracted?.keywords ?? []);
    const top_keywords = topN(allKeywords.map((k) => ({ k })), (x) => x.k, 12);

    const decisions = typed
      .filter((n) => (n.tags ?? []).includes('decision'))
      .slice(0, 5)
      .map((n) => ({ text: n.summary ?? n.content.slice(0, 200), node_id: n.id }));

    const expiringThreshold = new Date(Date.now() + 7 * 86400_000).toISOString();
    const expiring = typed
      .filter((n) => n.ttl_at && n.ttl_at < expiringThreshold)
      .slice(0, 5)
      .map((n) => ({ node_id: n.id, ttl_at: n.ttl_at! }));

    const sample = typed
      .slice(0, 30)
      .map((n) => {
        const ex = n.metadata?.extracted;
        const head = ex?.title ?? n.summary ?? n.content.slice(0, 160);
        const author = ex?.author ? ` — ${ex.author}` : '';
        const site = ex?.site_name ?? n.source_app;
        const siteStr = site ? ` [${site}]` : '';
        return `- ${head}${author}${siteStr}`;
      })
      .join('\n');

    const window_label =
      days === 7 ? 'this week' : days === 30 ? 'this month' : `the last ${days} days`;

    const narrative = await deepseekReason({
      systemPrompt:
        'You write personal digests in 2 short paragraphs. Warm tone, first-person plural ("we noticed..."). No markdown headings. No emojis.',
      userPrompt: `Summarize what dominated the user's attention ${window_label}.

Memories:
${sample}

Top themes detected: ${themes.map((t) => t.label).join(', ') || 'none'}
Top people: ${people.map((p) => p.label).join(', ') || 'none'}
Top authors read: ${top_authors.map((a) => a.label).join(', ') || 'none'}
Top sites visited: ${top_sites.map((s) => s.label).join(', ') || 'none'}
Capture mix: ${type_breakdown.map((t) => `${t.count}× ${t.label}`).join(', ') || 'none'}`,
      maxTokens: 700,
    });

    return jsonResponse({
      ok: true,
      days,
      node_count: typed.length,
      insight: {
        window_days: days,
        node_count: typed.length,
        themes,
        people,
        top_authors,
        top_sites,
        type_breakdown,
        top_keywords,
        decisions,
        expiring,
        narrative,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('insights-on-demand error', e);
    return errorResponse('internal_error', 500);
  }
});
