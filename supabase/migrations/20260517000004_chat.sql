-- Migration: Assistant chatbot — conversations + messages
-- The assistant uses RAG over the user's own context_nodes.

CREATE TABLE public.chat_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT 'New chat',
  pinned      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_sessions_user_updated
  ON public.chat_sessions (user_id, updated_at DESC);

CREATE TRIGGER chat_sessions_touch_updated_at
  BEFORE UPDATE ON public.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_sessions_own ON public.chat_sessions
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE TABLE public.chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES public.chat_sessions(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('user','assistant','system')),
  content     text NOT NULL,
  -- Memories used as context for an assistant message (RAG provenance).
  cited_nodes uuid[] NOT NULL DEFAULT '{}',
  -- Cost + perf telemetry (per assistant turn)
  model       text,
  tokens_in   integer,
  tokens_out  integer,
  latency_ms  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_messages_session
  ON public.chat_messages (session_id, created_at);
CREATE INDEX idx_chat_messages_user_recent
  ON public.chat_messages (user_id, created_at DESC);

ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY chat_messages_own ON public.chat_messages
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Auto-update parent session's updated_at when a new message lands
CREATE OR REPLACE FUNCTION public.touch_chat_session()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.chat_sessions SET updated_at = now() WHERE id = NEW.session_id;
  RETURN NEW;
END $$;

CREATE TRIGGER chat_messages_touch_session
  AFTER INSERT ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.touch_chat_session();
