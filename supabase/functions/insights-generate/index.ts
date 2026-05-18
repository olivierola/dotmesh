/**
 * POST /functions/v1/insights-generate
 * body: { user_id }   (service-role only, invoked by cron Monday 9am UTC)
 *
 * Builds a Weekly Insights row by:
 *   1. Aggregating last 7 days of nodes for the user
 *   2. Counting entity occurrences (people, topics, projects)
 *   3. Picking decision-tagged nodes
 *   4. Listing nodes expiring soon
 *   5. Asking DeepSeek for a 2-paragraph narrative
 *
 * Upserts to weekly_insights by (user_id, week_start).
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
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

interface Node {
  id: string;
  content: string;
  summary: string | null;
  entities: Entity[];
  tags: string[];
  ttl_at: string | null;
  created_at: string;
}

function startOfWeek(d = new Date()): Date {
  const day = d.getUTCDay() || 7; // Sunday = 0 → 7
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  out.setUTCDate(out.getUTCDate() - day + 1); // Monday
  return out;
}

function topN<T>(items: T[], keyFn: (t: T) => string, n: number): Array<{ label: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    counts[k] = (counts[k] ?? 0) + 1;
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

  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`) {
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
      .select('id, content, summary, entities, tags, ttl_at, created_at')
      .eq('user_id', user_id)
      .gt('created_at', sevenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return errorResponse('fetch_failed', 500, error);
    if (!nodes || nodes.length === 0) {
      return jsonResponse({ ok: true, note: 'no nodes this week', node_count: 0 });
    }

    const typed = nodes as Node[];

    // Top themes: by topic/project entities
    const topicEntities = typed.flatMap((n) =>
      (n.entities ?? []).filter((e) => e.type === 'TOPIC' || e.type === 'PROJECT'),
    );
    const themes = topN(topicEntities, (e) => e.value, 5);

    // Top people
    const personEntities = typed.flatMap((n) =>
      (n.entities ?? []).filter((e) => e.type === 'PERSON'),
    );
    const people = topN(personEntities, (e) => e.value, 8);

    // Decisions: nodes with tag 'decision' or whose content contains decision signal
    const decisions = typed
      .filter((n) => n.tags.includes('decision'))
      .slice(0, 5)
      .map((n) => ({ text: n.summary ?? n.content.slice(0, 200), node_id: n.id }));

    // Expiring: TTL within next 7 days
    const expiringThreshold = new Date(Date.now() + 7 * 86400_000).toISOString();
    const expiring = typed
      .filter((n) => n.ttl_at && n.ttl_at < expiringThreshold)
      .slice(0, 5)
      .map((n) => ({ node_id: n.id, ttl_at: n.ttl_at }));

    // Narrative via DeepSeek (optional, gracefully degrades)
    const sample = typed
      .slice(0, 30)
      .map((n) => `- ${n.summary ?? n.content.slice(0, 200)}`)
      .join('\n');
    const narrative = await deepseekReason({
      systemPrompt:
        'You write personal weekly digests in 2 short paragraphs. Warm tone, first-person plural ("we noticed..."). No markdown headings. No emojis.',
      userPrompt: `Here are the user's main memories this week. Summarize the themes, key people, and one thing worth following up on.

Memories:
${sample}

Top themes detected: ${themes.map((t) => t.label).join(', ') || 'none'}
Top people: ${people.map((p) => p.label).join(', ') || 'none'}`,
      maxTokens: 700,
    });

    await service.from('weekly_insights').upsert(
      {
        user_id,
        week_start: weekStart.toISOString().split('T')[0],
        themes,
        people,
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
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('insights-generate error', e);
    return errorResponse('internal_error', 500);
  }
});
