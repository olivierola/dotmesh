/**
 * POST /functions/v1/agents-meeting-prep
 *   body: { user_id, lead_minutes? }
 *
 * Looks at the user's next calendar event(s) starting within `lead_minutes`
 * (default from prefs) and produces a brief: attendees, recent memories
 * involving them, last decisions, open follow-ups.
 *
 * One run = one upcoming meeting. If multiple meetings imminent, picks the
 * earliest one not yet briefed today.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { jinaEmbed, groqChat } from '../_shared/ai.ts';
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
  lead_minutes?: number;
}

interface CalNode {
  id: string;
  content: string;
  summary: string | null;
  metadata: {
    event_id?: string;
    start?: { dateTime?: string; date?: string };
    attendees_count?: number;
  };
  source_url: string | null;
  entities: Array<{ type: string; value: string; normalized: string }>;
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
  let leadOverride: number | undefined;
  try {
    const body = await parseJsonBody<Input>(req);
    userId = body.user_id;
    triggeredBy = body.triggered_by ?? 'cron';
    leadOverride = body.lead_minutes;
  } catch (e) {
    return errorResponse('invalid_payload', 400, (e as Error).message);
  }

  const { enabled, prefs } = await isAgentEnabled(service, userId, 'meeting_prep');
  if (!enabled) {
    await skipRun(service, userId, 'meeting_prep', 'disabled_by_user', triggeredBy);
    return jsonResponse({ ok: true, skipped: 'disabled' });
  }

  const lead = leadOverride ?? prefs.lead_minutes ?? 30;

  try {
    // Find upcoming calendar nodes whose start falls between now and now+lead minutes
    const now = new Date();
    const horizon = new Date(now.getTime() + lead * 60_000);

    const { data: calNodes } = await service
      .from('context_nodes')
      .select('id, content, summary, metadata, source_url, entities')
      .eq('user_id', userId)
      .eq('source', 'connector:gcal')
      .gt('created_at', new Date(Date.now() - 14 * 86400_000).toISOString())
      .limit(60);

    const upcoming = ((calNodes ?? []) as CalNode[]).filter((n) => {
      const startStr = n.metadata?.start?.dateTime ?? n.metadata?.start?.date;
      if (!startStr) return false;
      const t = new Date(startStr).getTime();
      return t > now.getTime() && t <= horizon.getTime();
    });

    if (upcoming.length === 0) {
      await skipRun(service, userId, 'meeting_prep', 'no_upcoming_meeting', triggeredBy);
      return jsonResponse({ ok: true, skipped: 'no_upcoming_meeting' });
    }

    // Pick the earliest meeting not yet briefed today
    upcoming.sort((a, b) => {
      const ta = new Date(a.metadata?.start?.dateTime ?? a.metadata?.start?.date ?? 0).getTime();
      const tb = new Date(b.metadata?.start?.dateTime ?? b.metadata?.start?.date ?? 0).getTime();
      return ta - tb;
    });
    const meeting = upcoming[0]!;
    const meetingEventId = meeting.metadata.event_id;

    if (meetingEventId) {
      const todayUtc = new Date().toISOString().split('T')[0]!;
      const { data: existing } = await service
        .from('agent_runs')
        .select('id')
        .eq('user_id', userId)
        .eq('agent_type', 'meeting_prep')
        .eq('status', 'success')
        .gte('created_at', `${todayUtc}T00:00:00Z`)
        .contains('output', { metadata: { event_id: meetingEventId } })
        .limit(1)
        .maybeSingle();
      if (existing) {
        await skipRun(service, userId, 'meeting_prep', 'already_briefed', triggeredBy);
        return jsonResponse({ ok: true, skipped: 'already_briefed', run_id: existing.id });
      }
    }

    const runId = await startRun(service, userId, 'meeting_prep', triggeredBy);

    // Pull memories related to this meeting (people + topic)
    const personEntities = meeting.entities
      .filter((e) => e.type === 'PERSON')
      .map((e) => e.normalized);

    // Semantic search: embed meeting summary, hybrid_search top 10
    const meetingText = `${meeting.summary ?? meeting.content}`;
    const embedding = await jinaEmbed(meetingText);
    const queryVec = embedding ?? new Array(1024).fill(0);

    const { data: relatedRaw } = await service.rpc('hybrid_search_for_user', {
      p_user_id: userId,
      p_query_text: meetingText,
      p_query_embedding: queryVec,
      p_top_k: 10,
    });

    const related = ((relatedRaw ?? []) as Array<{
      id: string;
      summary: string | null;
      content: string;
      source: string;
      created_at: string;
      score: number;
    }>).filter((r) => r.id !== meeting.id && r.score > 0.15);

    // Build the brief
    const bullets = related
      .slice(0, 8)
      .map(
        (r, i) =>
          `[${i + 1}] (${new Date(r.created_at).toISOString().split('T')[0]} · ${r.source}) ${
            r.summary ?? r.content.slice(0, 200)
          }`,
      )
      .join('\n');

    const startStr = meeting.metadata?.start?.dateTime ?? meeting.metadata?.start?.date;
    const userPrompt = `Upcoming meeting:
${meeting.summary ?? meeting.content.slice(0, 400)}
Start: ${startStr}

Relevant memories:
${bullets || '(none found)'}

Write a JSON pre-meeting brief:
{
  "title": "Brief: <meeting name> (max 60 chars)",
  "summary": "3-5 sentence backgrounder of what matters for this meeting.",
  "items": [
    { "text": "Talking point / open question / fact to remember" }
  ]
}

Rules:
- 3 to 5 items
- Pull concrete facts from the memories, cite by [n] if you reference them
- Match language of the memories
- No emoji, no markdown.`;

    const raw = await groqChat({
      model: 'llama-3.3-70b-versatile',
      systemPrompt: 'You write pre-meeting briefs in strict JSON.',
      userPrompt,
      jsonMode: true,
      maxTokens: 800,
      feature: 'agent-meeting-prep',
      userId,
    });

    if (!raw) {
      await failRun(service, runId, 'llm_unavailable');
      return errorResponse('llm_unavailable', 503);
    }

    let parsed: { title?: string; summary?: string; items?: Array<{ text: string }> };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      await failRun(service, runId, `bad_json: ${raw.slice(0, 200)}`);
      return errorResponse('bad_llm_json', 502);
    }

    const output: AgentOutput = {
      title: parsed.title?.slice(0, 80) ?? `Brief: upcoming meeting`,
      summary: parsed.summary ?? '',
      items: (parsed.items ?? [])
        .slice(0, 5)
        .map((it) => ({ text: String(it.text ?? '').slice(0, 280) })),
      cited_nodes: related.slice(0, 5).map((r) => r.id),
      metadata: {
        event_id: meetingEventId,
        start: startStr,
        people: personEntities,
        source_url: meeting.source_url,
      },
    };

    await completeRun(service, runId, {
      output,
      nodes_considered: 1 + related.length,
      llm_model: 'llama-3.3-70b-versatile',
      latency_ms: Date.now() - startMs,
    });

    return jsonResponse({ ok: true, run_id: runId, output });
  } catch (e) {
    console.error('meeting-prep error', e);
    return errorResponse('agent_failed', 500, (e as Error).message);
  }
});
