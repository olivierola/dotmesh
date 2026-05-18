/**
 * POST /functions/v1/agents-daily-briefing
 *
 * body: { user_id, triggered_by?: 'cron' | 'manual' }
 *
 * Generates a "briefing" for one user covering the last 24h of captured memories
 * plus upcoming events (next 24h) — if Calendar is connected. Result is stored
 * in agent_runs.output and notified via Realtime.
 *
 * Service-role only.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { groqChat } from '../_shared/ai.ts';
import {
  startRun,
  completeRun,
  failRun,
  skipRun,
  isAgentEnabled,
  type AgentOutput,
} from '../_shared/agents.ts';

interface Input {
  user_id: string;
  triggered_by?: 'cron' | 'manual';
}

interface NodeRow {
  id: string;
  source: string;
  source_app: string | null;
  summary: string | null;
  content: string;
  entities: Array<{ type: string; value: string; normalized: string }>;
  tags: string[];
  created_at: string;
  ttl_at: string | null;
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`) {
    return errorResponse('forbidden', 403);
  }

  const startMs = Date.now();
  const service = createServiceClient();

  let userId: string;
  let triggeredBy: 'cron' | 'manual' = 'cron';
  try {
    const body = await parseJsonBody<Input>(req);
    userId = body.user_id;
    triggeredBy = body.triggered_by ?? 'cron';
    if (!userId) return errorResponse('user_id_required', 400);
  } catch (e) {
    return errorResponse('invalid_payload', 400, (e as Error).message);
  }

  const { enabled } = await isAgentEnabled(service, userId, 'daily_briefing');
  if (!enabled) {
    await skipRun(service, userId, 'daily_briefing', 'disabled_by_user', triggeredBy);
    return jsonResponse({ ok: true, skipped: 'disabled' });
  }

  // Dedup: don't run again if we already produced a briefing today
  if (triggeredBy === 'cron') {
    const todayUtc = new Date().toISOString().split('T')[0]!;
    const { data: existing } = await service
      .from('agent_runs')
      .select('id, created_at')
      .eq('user_id', userId)
      .eq('agent_type', 'daily_briefing')
      .eq('status', 'success')
      .gte('created_at', `${todayUtc}T00:00:00Z`)
      .limit(1)
      .maybeSingle();
    if (existing) {
      return jsonResponse({ ok: true, skipped: 'already_run_today', run_id: existing.id });
    }
  }

  const runId = await startRun(service, userId, 'daily_briefing', triggeredBy);

  try {
    const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString();
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();

    const [recentRes, upcomingRes] = await Promise.all([
      // Captures from the last 24h
      service
        .from('context_nodes')
        .select('id, source, source_app, summary, content, entities, tags, created_at, ttl_at')
        .eq('user_id', userId)
        .gt('created_at', yesterday)
        .order('created_at', { ascending: false })
        .limit(60),
      // Upcoming calendar items (next 24h) — only if Calendar connector is active
      service
        .from('context_nodes')
        .select('id, content, summary, metadata, created_at')
        .eq('user_id', userId)
        .eq('source', 'connector:gcal')
        .gt('created_at', yesterday)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    const recent = (recentRes.data ?? []) as NodeRow[];
    const upcoming = ((upcomingRes.data ?? []) as Array<{
      id: string;
      content: string;
      summary: string | null;
      metadata: Record<string, unknown>;
    }>).filter((n) => {
      const meta = n.metadata as { start?: { dateTime?: string; date?: string } } | null;
      const startStr = meta?.start?.dateTime ?? meta?.start?.date;
      if (!startStr) return false;
      return new Date(startStr).toISOString() < tomorrow && new Date(startStr).toISOString() > new Date().toISOString();
    });

    if (recent.length === 0 && upcoming.length === 0) {
      const output: AgentOutput = {
        title: 'Nothing new today',
        summary: 'No new memories or calendar events in the last 24 hours.',
        items: [],
        cited_nodes: [],
      };
      await completeRun(service, runId, {
        output,
        nodes_considered: 0,
        latency_ms: Date.now() - startMs,
      });
      return jsonResponse({ ok: true, run_id: runId, empty: true });
    }

    // Build the LLM prompt
    const recentBullets = recent
      .slice(0, 25)
      .map(
        (n, i) =>
          `[${i + 1}] (${new Date(n.created_at).toLocaleTimeString()} · ${n.source}) ${
            n.summary ?? n.content.slice(0, 240)
          }`,
      )
      .join('\n');

    const upcomingBullets = upcoming
      .map((n) => `- ${n.summary ?? n.content.slice(0, 200)}`)
      .join('\n');

    const userPrompt = `Yesterday's captured memories (most recent first):
${recentBullets || '(none)'}

Upcoming next 24h (from calendar):
${upcomingBullets || '(none)'}

Write a daily briefing in JSON, no markdown, with this exact shape:
{
  "title": "Short headline (max 60 chars)",
  "summary": "2-3 sentence overview of what matters today.",
  "items": [
    { "text": "Action or insight (1 line)", "due": "ISO date or null" }
  ]
}

Rules:
- 3 to 5 items, no more
- Items must be actionable or genuinely informative
- Match the language of the memories
- No emoji
`;

    const raw = await groqChat({
      model: 'llama-3.3-70b-versatile',
      systemPrompt:
        'You produce JSON-only daily briefings. Output strictly valid JSON, no surrounding markdown.',
      userPrompt,
      jsonMode: true,
      maxTokens: 800,
      feature: 'agent-daily-briefing',
      userId,
    });

    if (!raw) {
      await failRun(service, runId, 'llm_unavailable');
      return errorResponse('llm_unavailable', 503);
    }

    let parsed: { title?: string; summary?: string; items?: Array<{ text: string; due?: string | null }> };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      await failRun(service, runId, `bad_json: ${raw.slice(0, 200)}`);
      return errorResponse('bad_llm_json', 502);
    }

    const output: AgentOutput = {
      title: parsed.title?.slice(0, 80) ?? 'Daily briefing',
      summary: parsed.summary ?? '',
      items: (parsed.items ?? []).slice(0, 6).map((it) => ({
        text: String(it.text ?? '').slice(0, 240),
        due: it.due ?? null,
      })),
      cited_nodes: recent.slice(0, 5).map((n) => n.id),
    };

    await completeRun(service, runId, {
      output,
      nodes_considered: recent.length + upcoming.length,
      llm_model: 'llama-3.3-70b-versatile',
      latency_ms: Date.now() - startMs,
    });

    return jsonResponse({ ok: true, run_id: runId, output });
  } catch (e) {
    await failRun(service, runId, (e as Error).message);
    return errorResponse('agent_failed', 500, (e as Error).message);
  }
});
