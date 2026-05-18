-- Migration: context_nodes — the heart of Mesh memory graph

CREATE TABLE public.context_nodes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source          text NOT NULL,
  source_url      text,
  source_app      text,
  content         text NOT NULL,
  summary         text,
  embedding       vector(1024),
  embedding_model text DEFAULT 'jina-v3',
  entities        jsonb NOT NULL DEFAULT '[]'::jsonb,
  tags            text[] NOT NULL DEFAULT '{}',
  user_tags       text[] NOT NULL DEFAULT '{}',
  score           real CHECK (score IS NULL OR (score BETWEEN 0 AND 1)),
  sensitivity     real CHECK (sensitivity IS NULL OR (sensitivity BETWEEN 0 AND 1)),
  acl_agents      text[] NOT NULL DEFAULT ARRAY['*'],
  ttl_at          timestamptz,
  pinned          boolean NOT NULL DEFAULT false,
  edited_summary  text,
  fingerprint     text NOT NULL,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT content_not_empty CHECK (length(content) >= 1),
  CONSTRAINT content_size_limit CHECK (length(content) <= 50000)
);

-- Indexes
CREATE INDEX idx_nodes_user_created  ON public.context_nodes (user_id, created_at DESC);
CREATE INDEX idx_nodes_user_source   ON public.context_nodes (user_id, source);
CREATE INDEX idx_nodes_entities      ON public.context_nodes USING gin (entities);
CREATE INDEX idx_nodes_tags          ON public.context_nodes USING gin (tags);
CREATE INDEX idx_nodes_user_tags     ON public.context_nodes USING gin (user_tags);
CREATE UNIQUE INDEX idx_nodes_user_fp ON public.context_nodes (user_id, fingerprint);
CREATE INDEX idx_nodes_ttl           ON public.context_nodes (ttl_at) WHERE ttl_at IS NOT NULL;
CREATE INDEX idx_nodes_pinned        ON public.context_nodes (user_id, pinned) WHERE pinned = true;

-- HNSW vector index (cosine)
CREATE INDEX idx_nodes_embedding
  ON public.context_nodes
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Full-text search (hybrid dense + sparse)
ALTER TABLE public.context_nodes ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(summary, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B')
  ) STORED;
CREATE INDEX idx_nodes_fts ON public.context_nodes USING gin (content_tsv);

-- Touch updated_at
CREATE TRIGGER context_nodes_touch_updated_at
  BEFORE UPDATE ON public.context_nodes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- RLS
ALTER TABLE public.context_nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY nodes_select_own ON public.context_nodes
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY nodes_insert_own ON public.context_nodes
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY nodes_update_own ON public.context_nodes
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY nodes_delete_own ON public.context_nodes
  FOR DELETE USING (user_id = auth.uid());
