-- Migration: user-defined custom instructions.
--
-- Each instruction is a small reusable directive the user wants prepended
-- to AI prompts ("always answer in French", "for React code give me
-- the diff only", etc.). The injection flow picks the most relevant
-- instructions by cosine similarity between the user's current prompt
-- and the instruction's embedding. Zero matches = no injection — many
-- prompts don't need any custom guidance.
--
-- Shape mirrors collections: scoped to the user, embedded for ANN, with
-- RLS that allows the user to do everything on their own rows and the
-- service role to read any (the inject function runs as service role).

BEGIN;

CREATE TABLE public.instructions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  /** Free-form short context the user can write to explain WHEN this
   *  applies — fed into the embedding alongside the title and body. */
  context         text,
  /** The actual instruction body that gets prepended to the AI prompt. */
  instruction     text NOT NULL CHECK (length(instruction) BETWEEN 1 AND 4000),
  enabled         boolean NOT NULL DEFAULT true,
  /** Vector embedding of `title || context || instruction`, computed by
   *  the instructions function after each create/update. Same dimension
   *  as the node embeddings so we can re-use the Jina pipeline. */
  embedding       vector(1024),
  embedding_model text DEFAULT 'jina-v3',
  /** Optional emoji + accent colour so the grid of cards has personality. */
  icon            text,
  color           text,
  /** Manual ordering on the grid; smaller values render first. */
  sort_order      integer NOT NULL DEFAULT 100,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_instructions_user_sort
  ON public.instructions (user_id, sort_order, created_at);

CREATE INDEX idx_instructions_user_enabled
  ON public.instructions (user_id, enabled);

-- ANN over the embedding (cosine). Mirrors the context_nodes index.
CREATE INDEX idx_instructions_embedding
  ON public.instructions
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TRIGGER instructions_touch_updated_at
  BEFORE UPDATE ON public.instructions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.instructions ENABLE ROW LEVEL SECURITY;

CREATE POLICY instructions_own ON public.instructions
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Service role bypass (used by /inject when running as system).
CREATE POLICY instructions_service_read ON public.instructions
  FOR SELECT
  USING (auth.role() = 'service_role');

-- ----------------------------------------------------------------
-- Helper: top-K instructions matching a query embedding for a user.
-- Filter to enabled-only by default. Returns id, title, instruction
-- and a similarity score for each match.
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_instructions(
  p_user_id          uuid,
  p_query_embedding  vector(1024),
  p_top_k            integer DEFAULT 3,
  p_min_score        real    DEFAULT 0.55
)
RETURNS TABLE (
  id          uuid,
  title       text,
  context     text,
  instruction text,
  score       real
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  SELECT
    i.id,
    i.title,
    i.context,
    i.instruction,
    (1 - (i.embedding <=> p_query_embedding))::real AS score
  FROM public.instructions i
  WHERE i.user_id = p_user_id
    AND i.enabled = true
    AND i.embedding IS NOT NULL
    AND (1 - (i.embedding <=> p_query_embedding)) >= p_min_score
  ORDER BY i.embedding <=> p_query_embedding
  LIMIT p_top_k;
$$;

GRANT EXECUTE ON FUNCTION public.match_instructions(uuid, vector, integer, real)
  TO authenticated, service_role;

COMMIT;
