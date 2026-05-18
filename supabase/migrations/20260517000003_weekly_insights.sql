-- Migration: weekly insights digest

CREATE TABLE public.weekly_insights (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  week_start    date NOT NULL,
  themes        jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{label, count}]
  people        jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{name, count}]
  decisions     jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{text, node_id}]
  expiring      jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{node_id, ttl_at}]
  narrative     text,                                       -- DeepSeek-generated prose
  node_count    integer NOT NULL DEFAULT 0,
  delivered_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_insights_user_week ON public.weekly_insights (user_id, week_start);
CREATE INDEX idx_insights_recent ON public.weekly_insights (user_id, created_at DESC);

ALTER TABLE public.weekly_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY insights_read_own ON public.weekly_insights
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY insights_modify_service ON public.weekly_insights
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
