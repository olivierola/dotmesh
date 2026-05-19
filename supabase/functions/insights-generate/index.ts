/**
 * POST /functions/v1/insights-generate
 * body: { user_id }   (service-role only, invoked by cron Monday 9am UTC)
 *
 * Builds a Weekly Insights row from the last 7 days of nodes. With the
 * canonical metadata.extracted in place, we can aggregate signals that
 * used to require an LLM pass:
 *   - themes:         topic/project entities (legacy)
 *   - people:         person entities (legacy)
 *   - top_authors:    metadata.extracted.author across the week
 *   - top_sites:      metadata.extracted.site_name / source_app
 *   - type_breakdown: counts per node_type (text, image, video, ...)
 *   - top_keywords:   union of metadata.extracted.keywords
 *   - decisions:      nodes tagged "decision" (legacy)
 *   - expiring:       nodes with TTL in next 7 days (legacy)
 *   - narrative:      DeepSeek 2-paragraph prose
 *
 * Upserts to weekly_insights by (user_id, week_start).
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient, assertServiceRole } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { deepseekReason } from '../_shared/ai.ts';

interface Input {
  user_id: string;
}

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

function startOfWeek(d = new Date()): Date {
  const day = d.getUTCDay() || 7;
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  out.setUTCDate(out.getUTCDate() - day + 1);
  return out;
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
    assertServiceRole(req);
  } catch (e) {
    if (e instanceof Response) return e;
    return errorResponse('forbidden', 403);
  }

  try {
    const { user_id } = await parseJsonBody<Input>(req);
    if (!user_id) return errorResponse('user_id_required', 400);

    const service = createServiceClient();
    const weekStart = startOfWeek();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

    const { data: nodes, error } = await service
      .from('context_nodes')
      .select(
        'id, content, summary, entities, tags, ttl_at, created_at, source_app, node_type, metadata',
      )
      .eq('user_id', user_id)
      .gt('created_at', sevenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return errorResponse('fetch_failed', 500, error);
    if (!nodes || nodes.length === 0) {
      return jsonResponse({ ok: true, note: 'no nodes this week', node_count: 0 });
    }

    const typed = nodes as Node[];

    // ---- Entity-based signals (legacy) -----------------------------------
    const topicEntities = typed.flatMap((n) =>
      (n.entities ?? []).filter((e) => e.type === 'TOPIC' || e.type === 'PROJECT'),
    );
    const themes = topN(topicEntities, (e) => e.value, 5);

    const personEntities = typed.flatMap((n) =>
      (n.entities ?? []).filter((e) => e.type === 'PERSON'),
    );
    const people = topN(personEntities, (e) => e.value, 8);

    // ---- Extracted-based signals (new) -----------------------------------
    const top_authors = topN(typed, (n) => n.metadata?.extracted?.author ?? null, 8);
    const top_sites = topN(
      typed,
      (n) => n.metadata?.extracted?.site_name ?? n.source_app ?? null,
      8,
    );

    // type_breakdown: list every node_type seen, in descending count.
    const type_breakdown = topN(
      typed,
      (n) => n.node_type ?? n.metadata?.extracted?.author /* never matches */ ?? 'text',
      8,
    );

    const allKeywords = typed.flatMap((n) => n.metadata?.extracted?.keywords ?? []);
    const top_keywords = topN(allKeywords.map((k) => ({ k })), (x) => x.k, 12);

    // ---- Decisions & expirations (legacy) --------------------------------
    const decisions = typed
      .filter((n) => (n.tags ?? []).includes('decision'))
      .slice(0, 5)
      .map((n) => ({ text: n.summary ?? n.content.slice(0, 200), node_id: n.id }));

    const expiringThreshold = new Date(Date.now() + 7 * 86400_000).toISOString();
    const expiring = typed
      .filter((n) => n.ttl_at && n.ttl_at < expiringThreshold)
      .slice(0, 5)
      .map((n) => ({ node_id: n.id, ttl_at: n.ttl_at }));

    // ---- Narrative via DeepSeek (graceful fallback) -----------------------
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

    const narrative = await deepseekReason({
      systemPrompt:
        'You write personal weekly digests in 2 short paragraphs. Warm tone, first-person plural ("we noticed..."). No markdown headings. No emojis.',
      userPrompt: `Here are the user's main memories this week. Summarize the dominant themes, the people and authors that recurred, and one thing worth following up on.

Memories:
${sample}

Top themes detected: ${themes.map((t) => t.label).join(', ') || 'none'}
Top people: ${people.map((p) => p.label).join(', ') || 'none'}
Top authors read: ${top_authors.map((a) => a.label).join(', ') || 'none'}
Top sites visited: ${top_sites.map((s) => s.label).join(', ') || 'none'}
Capture mix: ${type_breakdown.map((t) => `${t.count}× ${t.label}`).join(', ') || 'none'}`,
      maxTokens: 700,
    });

    await service.from('weekly_insights').upsert(
      {
        user_id,
        week_start: weekStart.toISOString().split('T')[0],
        themes,
        people,
        top_authors,
        top_sites,
        type_breakdown,
        top_keywords,
        decisions,
        expiring,
        narrative,
        node_count: typed.length,
      },
      { onConflict: 'user_id,week_start' },
    );

    return jsonResponse({
      ok: true,
      week_start: weekStart.toISOString().split('T')[0],
      node_count: typed.length,
      themes_count: themes.length,
      people_count: people.length,
      authors_count: top_authors.length,
      sites_count: top_sites.length,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('insights-generate error', e);
    return errorResponse('internal_error', 500);
  }
});
