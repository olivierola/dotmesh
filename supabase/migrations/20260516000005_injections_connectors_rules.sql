-- Migration: injections log, connectors (Agent Hub), context rules (ACL)

-- ============ injections ============
CREATE TABLE public.injections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  target_agent    text NOT NULL,
  query_hash      text NOT NULL,
  query_excerpt   text,
  node_ids        uuid[] NOT NULL DEFAULT '{}',
  injected_text   text,
  user_accepted   boolean,
  latency_ms      integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_injections_user_created ON public.injections (user_id, created_at DESC);
CREATE INDEX idx_injections_agent ON public.injections (user_id, target_agent);

ALTER TABLE public.injections ENABLE ROW LEVEL SECURITY;
CREATE POLICY injections_select_own ON public.injections
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY injections_insert_own ON public.injections
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- ============ connectors ============
CREATE TABLE public.connectors (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider            text NOT NULL
                        CHECK (provider IN ('gmail','gcal','slack','notion','linear','github','figma','gdocs')),
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','paused','error','revoked')),
  oauth_access_token  text,
  oauth_refresh_token text,
  oauth_expires_at    timestamptz,
  scopes              text[] NOT NULL DEFAULT '{}',
  last_sync_at        timestamptz,
  last_sync_cursor    text,
  sync_settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_connectors_user_provider ON public.connectors (user_id, provider);
CREATE INDEX idx_connectors_status ON public.connectors (status, last_sync_at);

CREATE TRIGGER connectors_touch_updated_at
  BEFORE UPDATE ON public.connectors
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.connectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY connectors_select_own ON public.connectors
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY connectors_modify_own ON public.connectors
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============ context_rules ============
CREATE TABLE public.context_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  rule_type   text NOT NULL CHECK (rule_type IN ('agent_acl','tag_block','domain_block','time_window')),
  target      text NOT NULL,
  action      text NOT NULL CHECK (action IN ('allow','deny','redact')),
  filter      jsonb NOT NULL DEFAULT '{}'::jsonb,
  priority    integer NOT NULL DEFAULT 100,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rules_user ON public.context_rules (user_id, priority DESC) WHERE enabled = true;

ALTER TABLE public.context_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY rules_modify_own ON public.context_rules
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
