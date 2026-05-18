/**
 * GET  /functions/v1/agents              list recent runs
 * POST /functions/v1/agents/run          { type: 'daily_briefing'|'follow_up'|'meeting_prep' } — trigger manually
 * PATCH /functions/v1/agents/prefs       { agent_prefs: {…} } — update prefs (merge)
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';

const AGENT_TYPES = ['daily_briefing', 'follow_up', 'meeting_prep'] as const;
const FN_MAP: Record<(typeof AGENT_TYPES)[number], string> = {
  daily_briefing: 'agents-daily-briefing',
  follow_up: 'agents-follow-up',
  meeting_prep: 'agents-meeting-prep',
};

const runSchema = z.object({
  type: z.enum(AGENT_TYPES),
});

const prefsSchema = z.object({
  daily_briefing: z
    .object({ enabled: z.boolean().optional(), hour_utc: z.number().int().min(0).max(23).optional() })
    .partial()
    .optional(),
  follow_up: z.object({ enabled: z.boolean().optional() }).partial().optional(),
  meeting_prep: z
    .object({ enabled: z.boolean().optional(), lead_minutes: z.number().int().min(1).max(180).optional() })
    .partial()
    .optional(),
});

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  try {
    const { userId, client } = await requireUser(req);
    const url = new URL(req.url);
    const action = url.pathname.split('/').pop();

    if (req.method === 'GET' && (action === 'agents' || !action)) {
      const [runsRes, userRes] = await Promise.all([
        client
          .from('agent_runs')
          .select('id, agent_type, status, output, latency_ms, error_message, created_at, finished_at')
          .order('created_at', { ascending: false })
          .limit(30),
        client.from('users').select('agent_prefs').eq('id', userId).maybeSingle(),
      ]);
      if (runsRes.error) return errorResponse('list_failed', 500, runsRes.error);
      return jsonResponse({
        runs: runsRes.data ?? [],
        prefs: userRes.data?.agent_prefs ?? {},
      });
    }

    if (req.method === 'POST' && action === 'run') {
      const body = await parseJsonBody<unknown>(req);
      const parsed = runSchema.safeParse(body);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const fn = FN_MAP[parsed.data.type];
      const supaUrl = Deno.env.get('SUPABASE_URL')!;
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

      // Fire-and-forget: kick off the agent on the server side.
      // The UI will pick up the result via Realtime / a re-fetch.
      fetch(`${supaUrl}/functions/v1/${fn}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: userId, triggered_by: 'manual' }),
      }).catch((e) => console.warn('agent kickoff failed', e));

      return jsonResponse({ ok: true, triggered: parsed.data.type });
    }

    if (req.method === 'PATCH' && action === 'prefs') {
      const body = await parseJsonBody<unknown>(req);
      const parsed = prefsSchema.safeParse(body);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const { data: existing } = await client
        .from('users')
        .select('agent_prefs')
        .eq('id', userId)
        .maybeSingle();
      const current = (existing?.agent_prefs ?? {}) as Record<string, Record<string, unknown>>;
      const merged: Record<string, Record<string, unknown>> = { ...current };
      for (const k of AGENT_TYPES) {
        if (parsed.data[k]) merged[k] = { ...(current[k] ?? {}), ...(parsed.data[k] as Record<string, unknown>) };
      }
      const { error } = await client
        .from('users')
        .update({ agent_prefs: merged })
        .eq('id', userId);
      if (error) return errorResponse('update_failed', 500, error);
      return jsonResponse({ ok: true, agent_prefs: merged });
    }

    return errorResponse('method_not_allowed', 405);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('agents error', e);
    return errorResponse('internal_error', 500);
  }
});
