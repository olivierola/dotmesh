/**
 * POST /functions/v1/agents-follow-up
 * Scans memories from the last 14 days and surfaces commitments the user made
 * ("I'll send you …", "let's revisit on Monday", "before Friday") that haven't
 * been resolved.
 *
 * Heuristic first, LLM only on candidates (cheap).
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
  summary: string | null;
  content: string;
  entities: Array<{ type: string; value: string; normalized: string }>;
  created_at: string;
}

// English + French commitment markers
const COMMITMENT_REGEXES = [
  /\bI'?ll (send|share|review|get back|follow up|revisit|email|ping|ship|deliver)\b/i,
  /\bwill (send|share|review|get back|follow up|revisit|email|ping|ship|deliver)\b/i,
  /\blet's (revisit|sync|check|discuss|talk|review)\b/i,
  /\bby (monday|tuesday|wednesday|thursday|friday|next week|end of week|EOW|EOD)\b/i,
  /\b(je|nous) (renverr|enverr|reviendr|recontacter|partager)/i,
  /\b(d'ici|avant) (lundi|mardi|mercredi|jeudi|vendredi|la fin)/i,
  /\bpromis(e)?\b/i,
];

function hasCommitmentMarker(text: string): boolean {
  return COMMITMENT_REGEXES.some((re) => re.test(text));
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
  } catch (e) {
    return errorResponse('invalid_payload', 400, (e as Error).message);
  }

  const { enabled } = await isAgentEnabled(service, userId, 'follow_up');
  if (!enabled) {
    await skipRun(service, userId, 'follow_up', 'disabled_by_user', triggeredBy);
    return jsonResponse({ ok: true, skipped: 'disabled' });
  }

  const runId = await startRun(service, userId, 'follow_up', triggeredBy);

  try {
    const since = new Date(Date.now() - 14 * 86400_000).toISOString();
    const { data: nodes, error } = await service
      .from('context_nodes')
      .select('id, summary, content, entities, created_at')
      .eq('user_id', userId)
      .gt('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) {
      await failRun(service, runId, error.message);
      return errorResponse('fetch_failed', 500, error);
    }

    // Phase 1: cheap regex filter
    const candidates = ((nodes ?? []) as NodeRow[]).filter((n) =>
      hasCommitmentMarker(n.summary ?? n.content),
    );

    if (candidates.length === 0) {
      const output: AgentOutput = {
        title: 'No open follow-ups',
        summary: 'Nothing looking like an unfinished commitment in the last 2 weeks.',
        items: [],
        cited_nodes: [],
      };
      await completeRun(service, runId, {
        output,
        nodes_considered: (nodes ?? []).length,
        latency_ms: Date.now() - startMs,
      });
      return jsonResponse({ ok: true, run_id: runId, empty: true });
    }

    // Phase 2: LLM filters + structures the real commitments
    const bullets = candidates
      .slice(0, 20)
      .map(
        (n, i) =>
          `[${i + 1}] (id=${n.id}, ${new Date(n.created_at).toISOString().split('T')[0]}) ${
            n.summary ?? n.content.slice(0, 280)
          }`,
      )
      .join('\n');

    const userPrompt = `You are looking at memory snippets that may contain commitments the user has made. Extract only the REAL pending commitments, ignoring vague mentions.

Snippets:
${bullets}

Return JSON:
{
  "items": [
    { "text": "Short paraphrase of the commitment (1 line, action-oriented)", "node_id": "uuid of the source", "due": "ISO date or null" }
  ]
}

Rules:
- Max 5 items, ranked by urgency
- node_id MUST match one of the IDs above
- If the commitment was clearly resolved already, skip it
- Output JSON only.
`;

    const raw = await groqChat({
      model: 'llama-3.3-70b-versatile',
      systemPrompt:
        'You extract pending commitments from memory snippets. Output strict JSON only.',
      userPrompt,
      jsonMode: true,
      maxTokens: 700,
      feature: 'agent-follow-up',
      userId,
    });

    if (!raw) {
      await failRun(service, runId, 'llm_unavailable');
      return errorResponse('llm_unavailable', 503);
    }

    let parsed: { items?: Array<{ text: string; node_id?: string; due?: string | null }> };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      await failRun(service, runId, `bad_json: ${raw.slice(0, 200)}`);
      return errorResponse('bad_llm_json', 502);
    }

    const validIds = new Set(candidates.map((c) => c.id));
    const items = (parsed.items ?? [])
      .map((it) => ({
        text: String(it.text ?? '').slice(0, 240),
        node_id: it.node_id && validIds.has(it.node_id) ? it.node_id : undefined,
        due: it.due ?? null,
      }))
      .filter((it) => it.text.length > 0)
      .slice(0, 5);

    const output: AgentOutput = {
      title: items.length > 0 ? `${items.length} follow-up${items.length > 1 ? 's' : ''} pending` : 'No open follow-ups',
      summary:
        items.length > 0
          ? `Detected ${items.length} commitment${items.length > 1 ? 's' : ''} worth a nudge.`
          : 'Nothing pending after closer review.',
      items,
      cited_nodes: items.map((i) => i.node_id).filter((id): id is string => !!id),
    };

    await completeRun(service, runId, {
      output,
      nodes_considered: candidates.length,
      llm_model: 'llama-3.3-70b-versatile',
      latency_ms: Date.now() - startMs,
    });

    return jsonResponse({ ok: true, run_id: runId, output });
  } catch (e) {
    await failRun(service, runId, (e as Error).message);
    return errorResponse('agent_failed', 500, (e as Error).message);
  }
});
