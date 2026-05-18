-- Migration: public embed tokens.
-- An embed token is a long-lived, scope-restricted key that lets a third-party
-- site call /embed-ask without exposing the user's main JWT.
--
-- The token itself is stored hashed; we only return the plaintext at creation time.

CREATE TABLE public.embed_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- SHA-256 of the plaintext token. We never store the plaintext.
  token_hash   text NOT NULL UNIQUE,
  -- Public prefix so we can show the token in the UI without revealing it.
  token_prefix text NOT NULL,
  name         text NOT NULL,
  -- Origin allowlist. Empty array → block all (must be configured).
  allowed_origins text[] NOT NULL DEFAULT '{}',
  -- Per-minute request quota (cheap default, user can raise via UI later).
  rate_limit_per_minute integer NOT NULL DEFAULT 20,
  -- Scope: which features the token can hit. Today only 'ask' is allowed.
  scopes       text[] NOT NULL DEFAULT ARRAY['ask'],
  active       boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  call_count   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_embed_tokens_user ON public.embed_tokens (user_id);
CREATE INDEX idx_embed_tokens_hash ON public.embed_tokens (token_hash);

ALTER TABLE public.embed_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY embed_tokens_own ON public.embed_tokens
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
