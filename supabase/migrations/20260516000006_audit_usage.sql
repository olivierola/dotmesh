-- Migration: immutable audit_log + usage_metrics

-- ============ audit_log (immutable) ============
CREATE TABLE public.audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  operation  text NOT NULL,
  node_ids   uuid[],
  source     text,
  ip_hash    text,
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_user_created ON public.audit_log (user_id, created_at DESC);
CREATE INDEX idx_audit_operation    ON public.audit_log (operation, created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

-- Read own only
CREATE POLICY audit_read_own ON public.audit_log
  FOR SELECT USING (user_id = auth.uid());

-- Insert via service role only (Edge Functions). No client INSERT.
CREATE POLICY audit_insert_service ON public.audit_log
  FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- No UPDATE policy = no updates possible
-- No DELETE policy = no deletes possible
-- Immutability enforced by absence of policies

-- ============ usage_metrics ============
CREATE TABLE public.usage_metrics (
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  date              date NOT NULL,
  nodes_created     integer NOT NULL DEFAULT 0,
  pulls_count       integer NOT NULL DEFAULT 0,
  injections_count  integer NOT NULL DEFAULT 0,
  llm_cost_cents    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE INDEX idx_usage_date ON public.usage_metrics (date);

ALTER TABLE public.usage_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY usage_read_own ON public.usage_metrics
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY usage_modify_service ON public.usage_metrics
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Helper: increment a metric atomically
CREATE OR REPLACE FUNCTION public.increment_usage(
  p_user_id uuid,
  p_field text,
  p_amount integer DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  EXECUTE format(
    'INSERT INTO public.usage_metrics (user_id, date, %1$I) VALUES ($1, current_date, $2)
     ON CONFLICT (user_id, date) DO UPDATE SET %1$I = public.usage_metrics.%1$I + $2',
    p_field
  ) USING p_user_id, p_amount;
END;
$$;
