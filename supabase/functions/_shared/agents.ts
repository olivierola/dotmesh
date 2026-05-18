/**
 * Shared agent utilities — running an agent = create a run row, execute,
 * write the output back.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export type AgentType = 'daily_briefing' | 'follow_up' | 'meeting_prep' | 'custom';

export interface AgentOutput {
  title: string;
  summary: string;
  /** Bulleted action items / takeaways. */
  items?: Array<{ text: string; node_id?: string; due?: string | null }>;
  /** Memory IDs cited as supporting context. */
  cited_nodes?: string[];
  metadata?: Record<string, unknown>;
}

/** Start a new run, returns the run id. */
export async function startRun(
  service: SupabaseClient,
  userId: string,
  type: AgentType,
  triggeredBy: 'cron' | 'manual' | 'event' = 'cron',
): Promise<string> {
  const { data, error } = await service
    .from('agent_runs')
    .insert({
      user_id: userId,
      agent_type: type,
      status: 'running',
      triggered_by: triggeredBy,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`run_insert_failed: ${error?.message}`);
  return data.id as string;
}

export async function completeRun(
  service: SupabaseClient,
  runId: string,
  opts: {
    output: AgentOutput;
    nodes_considered?: number;
    llm_model?: string;
    latency_ms?: number;
  },
): Promise<void> {
  await service
    .from('agent_runs')
    .update({
      status: 'success',
      output: opts.output,
      nodes_considered: opts.nodes_considered ?? null,
      llm_model: opts.llm_model ?? null,
      latency_ms: opts.latency_ms ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
}

export async function failRun(
  service: SupabaseClient,
  runId: string,
  errorMessage: string,
): Promise<void> {
  await service
    .from('agent_runs')
    .update({
      status: 'failed',
      error_message: errorMessage.slice(0, 1000),
      finished_at: new Date().toISOString(),
    })
    .eq('id', runId);
}

export async function skipRun(
  service: SupabaseClient,
  userId: string,
  type: AgentType,
  reason: string,
  triggeredBy: 'cron' | 'manual' | 'event' = 'cron',
): Promise<void> {
  await service.from('agent_runs').insert({
    user_id: userId,
    agent_type: type,
    status: 'skipped',
    triggered_by: triggeredBy,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    error_message: reason,
  });
}

interface AgentPrefShape {
  enabled?: boolean;
  hour_utc?: number;
  lead_minutes?: number;
}

export async function isAgentEnabled(
  service: SupabaseClient,
  userId: string,
  type: AgentType,
): Promise<{ enabled: boolean; prefs: AgentPrefShape }> {
  const { data } = await service
    .from('users')
    .select('agent_prefs, tier')
    .eq('id', userId)
    .maybeSingle();
  const all = (data?.agent_prefs ?? {}) as Record<string, AgentPrefShape>;
  const prefs = all[type] ?? {};
  // Free tier gets the daily briefing only; paid tiers get all agents.
  const tier = (data?.tier as 'free' | 'personal' | 'pro' | undefined) ?? 'free';
  if (tier === 'free' && type !== 'daily_briefing') {
    return { enabled: false, prefs };
  }
  return { enabled: prefs.enabled ?? true, prefs };
}
