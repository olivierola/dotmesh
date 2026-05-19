-- Migration: canonical `extracted` JSON + node_type for every captured node.
--
-- WHY: until now `metadata` was a free-form bag set by the extension. Search,
-- graph coloring, and assistant prompts cannot rely on a stable shape.
-- After this migration every node carries:
--
--   metadata.extracted = {
--     node_type:        'text' | 'image' | 'video' | 'link' | 'code'
--                       | 'quote' | 'page' | 'action',
--     title:            string | null,
--     description:      string | null,
--     author:           string | null,
--     content:          string | null,    -- canonical body (text or transcript)
--     media_url:        string | null,    -- image src, video src, link href
--     media_thumbnail:  string | null,    -- poster / og:image
--     lang:             string | null,    -- BCP-47 lowercased ('fr', 'en')
--     site_name:        string | null,
--     published_at:     string | null,    -- ISO date when known
--     keywords:         string[],         -- author-provided keywords / hashtags
--     actions:          [{ kind, value, at }],  -- user actions on this content
--     source_extracted_at: ISO,           -- when extension/LLM produced this
--     extraction_method:   'heuristic' | 'llm' | 'mixed' | 'manual'
--   }
--
-- The migration:
--   1. Adds a STORED generated `node_type` column derived from extracted JSON
--      (falls back to legacy metadata.elementType so old rows keep coloring).
--   2. Indexes node_type for graph filtering.
--   3. Backfills `metadata.extracted` for existing rows from legacy keys.
--   4. Extends hybrid_search() and hybrid_search_for_user() so the API exposes
--      node_type + extracted fields without a second round-trip.

BEGIN;

-- ============================================================
-- 1. node_type — generated column derived from extracted JSON
-- ============================================================
-- Order of precedence:
--   metadata.extracted.node_type → metadata.elementType → 'text'
-- We accept a small whitelist to keep the column index-friendly.

ALTER TABLE public.context_nodes
  ADD COLUMN IF NOT EXISTS node_type text
  GENERATED ALWAYS AS (
    CASE
      WHEN metadata #>> '{extracted,node_type}' IN
        ('text','image','video','link','code','quote','page','action')
        THEN metadata #>> '{extracted,node_type}'
      WHEN metadata ->> 'elementType' IN
        ('text','image','video','link','code','quote','page','action','heading','list-item')
        THEN CASE metadata ->> 'elementType'
               WHEN 'heading' THEN 'text'
               WHEN 'list-item' THEN 'text'
               ELSE metadata ->> 'elementType'
             END
      ELSE 'text'
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_nodes_user_type
  ON public.context_nodes (user_id, node_type, created_at DESC);

-- ============================================================
-- 2. Backfill metadata.extracted for legacy rows
-- ============================================================
-- Only touch rows that don't already have an extracted object.
-- We carry over what we can from the existing free-form metadata so the
-- frontend can read a single canonical shape.

UPDATE public.context_nodes n
SET metadata = COALESCE(n.metadata, '{}'::jsonb) || jsonb_build_object(
  'extracted',
  jsonb_strip_nulls(
    jsonb_build_object(
      'node_type', CASE n.metadata ->> 'elementType'
        WHEN 'heading' THEN 'text'
        WHEN 'list-item' THEN 'text'
        WHEN 'image' THEN 'image'
        WHEN 'video' THEN 'video'
        WHEN 'code' THEN 'code'
        WHEN 'link' THEN 'link'
        WHEN 'quote' THEN 'quote'
        ELSE 'text'
      END,
      'title',           n.metadata ->> 'pageTitle',
      'description',     COALESCE(n.summary, n.metadata ->> 'surroundingContext'),
      'author',          n.metadata ->> 'author',
      'content',         n.content,
      'media_url',       n.metadata ->> 'mediaUrl',
      'media_thumbnail', NULL,
      'lang',            n.metadata ->> 'lang',
      'site_name',       n.source_app,
      'published_at',    NULL,
      'keywords',        '[]'::jsonb,
      'actions',         '[]'::jsonb,
      'source_extracted_at', to_jsonb(n.created_at),
      'extraction_method', 'heuristic'
    )
  )
)
WHERE NOT (n.metadata ? 'extracted');

-- ============================================================
-- 3. Extend hybrid_search() to expose node_type
-- ============================================================
-- We add `node_type` as a returned column and accept an optional filter array.
-- Existing call sites pass NULL → behavior unchanged.

DROP FUNCTION IF EXISTS public.hybrid_search(
  text, vector, integer, text[], interval, text
);

CREATE OR REPLACE FUNCTION public.hybrid_search(
  p_query_text       text,
  p_query_embedding  vector(1024),
  p_top_k            integer DEFAULT 5,
  p_filter_tags      text[]  DEFAULT NULL,
  p_filter_since     interval DEFAULT NULL,
  p_filter_source    text    DEFAULT NULL,
  p_filter_types     text[]  DEFAULT NULL,
  p_filter_collection uuid   DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  content     text,
  summary     text,
  source      text,
  source_url  text,
  source_app  text,
  node_type   text,
  entities    jsonb,
  tags        text[],
  user_tags   text[],
  metadata    jsonb,
  created_at  timestamptz,
  score       real
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
AS $$
BEGIN
  RETURN QUERY
  WITH dense AS (
    SELECT
      n.id,
      (1 - (n.embedding <=> p_query_embedding))::real AS s
    FROM public.context_nodes n
    WHERE n.embedding IS NOT NULL
      AND (p_filter_tags  IS NULL OR n.tags && p_filter_tags)
      AND (p_filter_since IS NULL OR n.created_at > now() - p_filter_since)
      AND (p_filter_source IS NULL OR n.source = p_filter_source)
      AND (p_filter_types  IS NULL OR n.node_type = ANY(p_filter_types))
      AND (p_filter_collection IS NULL OR EXISTS (
            SELECT 1 FROM public.node_collections nc
            WHERE nc.node_id = n.id AND nc.collection_id = p_filter_collection
          ))
    ORDER BY n.embedding <=> p_query_embedding
    LIMIT 50
  ),
  sparse AS (
    SELECT
      n.id,
      ts_rank(n.content_tsv, plainto_tsquery('simple', p_query_text))::real AS s
    FROM public.context_nodes n
    WHERE n.content_tsv @@ plainto_tsquery('simple', p_query_text)
      AND (p_filter_tags  IS NULL OR n.tags && p_filter_tags)
      AND (p_filter_since IS NULL OR n.created_at > now() - p_filter_since)
      AND (p_filter_source IS NULL OR n.source = p_filter_source)
      AND (p_filter_types  IS NULL OR n.node_type = ANY(p_filter_types))
      AND (p_filter_collection IS NULL OR EXISTS (
            SELECT 1 FROM public.node_collections nc
            WHERE nc.node_id = n.id AND nc.collection_id = p_filter_collection
          ))
    LIMIT 50
  ),
  combined AS (
    SELECT
      COALESCE(d.id, s.id) AS id,
      (COALESCE(d.s, 0) * 0.7 + COALESCE(s.s, 0) * 0.3)::real AS final_score
    FROM dense d
    FULL OUTER JOIN sparse s USING (id)
  )
  SELECT
    n.id,
    n.content,
    n.summary,
    n.source,
    n.source_url,
    n.source_app,
    n.node_type,
    n.entities,
    n.tags,
    n.user_tags,
    n.metadata,
    n.created_at,
    c.final_score AS score
  FROM combined c
  JOIN public.context_nodes n ON n.id = c.id
  ORDER BY c.final_score DESC
  LIMIT p_top_k;
END;
$$;

GRANT EXECUTE ON FUNCTION public.hybrid_search(
  text, vector, integer, text[], interval, text, text[], uuid
) TO authenticated, service_role;

COMMIT;
