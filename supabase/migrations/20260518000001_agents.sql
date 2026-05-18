-- Migration: agents — autonomous & semi-autonomous workers.
--
-- An "agent run" is one execution of one agent type (daily_briefing, follow_up,
-- meeting_prep, …). Each user has prefs for which agents are enabled.
-- Outputs are persisted so the UI can render history without re-running.

CREATE TABLE public.agent_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  agent_type    text NOT NULL
                  CHECK (agent_type IN ('daily_briefing','follow_up','meeting_prep','custom')),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','success','failed','skipped')),
  -- Free-form structured output: { title, summary, items[], cited_nodes[] }
  output        jsonb,
  -- Stats
  nodes_considered integer,
  llm_model     text,
  latency_ms    integer,
  error_message text,
  triggered_by  text NOT NULL DEFAULT 'cron'
                  CHECK (triggered_by IN ('cron','manual','event')),
  scheduled_for timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_runs_user_recent
  ON public.agent_runs (user_id, created_at DESC);
CREATE INDEX idx_agent_runs_user_type
  ON public.agent_runs (user_id, agent_type, created_at DESC);
CREATE INDEX idx_agent_runs_pending
  ON public.agent_runs (status, scheduled_for)
  WHERE status = 'pending';

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_runs_read_own ON public.agent_runs
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY agent_runs_modify_service ON public.agent_runs
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ===== Per-user agent preferences =====
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS agent_prefs jsonb NOT NULL DEFAULT jsonb_build_object(
    'daily_briefing', jsonb_build_object('enabled', true, 'hour_utc', 6),
    'follow_up',      jsonb_build_object('enabled', true),
    'meeting_prep',   jsonb_build_object('enabled', true, 'lead_minutes', 30)
  );
