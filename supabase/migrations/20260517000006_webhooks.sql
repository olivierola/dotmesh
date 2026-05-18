-- Migration: outbound webhooks.
-- Users can register HTTP endpoints to be notified of events in their account.

CREATE TABLE public.webhooks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  url          text NOT NULL CHECK (url ~ '^https?://'),
  -- HMAC secret used to sign each delivery. Generated at creation, never returned to client.
  secret       text NOT NULL,
  -- Which event types this webhook listens to: 'node.created', 'node.deleted', 'injection', '*'
  events       text[] NOT NULL DEFAULT ARRAY['*'],
  description  text,
  active       boolean NOT NULL DEFAULT true,
  -- Stats / health
  last_delivered_at timestamptz,
  last_status   integer,
  failure_count integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhooks_user ON public.webhooks (user_id);
CREATE INDEX idx_webhooks_active ON public.webhooks (user_id, active) WHERE active = true;

CREATE TRIGGER webhooks_touch_updated_at
  BEFORE UPDATE ON public.webhooks
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.webhooks ENABLE ROW LEVEL SECURITY;
-- We expose all columns to the user EXCEPT the secret (handled by the view below).
CREATE POLICY webhooks_modify_own ON public.webhooks
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Public-safe view: hides the secret entirely.
CREATE OR REPLACE VIEW public.webhooks_public AS
SELECT
  id, user_id, url, events, description, active,
  last_delivered_at, last_status, failure_count,
  created_at, updated_at
FROM public.webhooks;

-- Inherit RLS from base table
ALTER VIEW public.webhooks_public SET (security_invoker = true);

-- ============================================================
-- Delivery queue
-- ============================================================

CREATE TABLE public.webhook_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id    uuid NOT NULL REFERENCES public.webhooks(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','success','failed','retrying','dead')),
  attempts      integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_response_code integer,
  last_response_body text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  delivered_at  timestamptz
);

CREATE INDEX idx_deliveries_pending
  ON public.webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending','retrying');
CREATE INDEX idx_deliveries_user
  ON public.webhook_deliveries (user_id, created_at DESC);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY deliveries_read_own ON public.webhook_deliveries
  FOR SELECT USING (user_id = auth.uid());

-- ============================================================
-- Trigger: enqueue deliveries on context_nodes events
-- ============================================================

CREATE OR REPLACE FUNCTION public.enqueue_node_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  evt text;
  payload_json jsonb;
  hook record;
BEGIN
  IF (TG_OP = 'INSERT') THEN
    evt := 'node.created';
    payload_json := jsonb_build_object(
      'event', evt,
      'node_id', NEW.id,
      'source', NEW.source,
      'tags', NEW.tags,
      'created_at', NEW.created_at
    );
  ELSIF (TG_OP = 'DELETE') THEN
    evt := 'node.deleted';
    payload_json := jsonb_build_object(
      'event', evt,
      'node_id', OLD.id,
      'deleted_at', now()
    );
  ELSE
    RETURN NULL;
  END IF;

  FOR hook IN
    SELECT id, user_id
    FROM public.webhooks
    WHERE active = true
      AND user_id = COALESCE(NEW.user_id, OLD.user_id)
      AND (events && ARRAY[evt] OR events && ARRAY['*'])
  LOOP
    INSERT INTO public.webhook_deliveries (webhook_id, user_id, event_type, payload, next_attempt_at)
    VALUES (hook.id, hook.user_id, evt, payload_json, now());
  END LOOP;

  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER context_nodes_webhook_emit
  AFTER INSERT OR DELETE ON public.context_nodes
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_node_webhook();
