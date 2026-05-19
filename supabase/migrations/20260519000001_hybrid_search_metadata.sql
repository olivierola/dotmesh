-- Migration: extend hybrid_search to return metadata + source_app.
--
-- The Assistant uses those fields to build a richer context block — without
-- them, image/video captures lose their mediaUrl, surroundingContext, heading,
-- author, etc. when injected into the LLM prompt.
--
-- Signature unchanged on the input side (so existing callers keep working);
-- only the RETURNS TABLE gains two columns at the end.

DROP FUNCTION IF EXISTS public.hybrid_search(
  text, vector, integer, text[], interval, text
);

CREATE OR REPLACE FUNCTION public.hybrid_search(
  p_query_text       text,
  p_query_embedding  vector(1024),
  p_top_k            integer DEFAULT 5,
  p_filter_tags      text[] DEFAULT NULL,
  p_filter_since     interval DEFAULT NULL,
  p_filter_source    text DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  content     text,
  summary     text,
  source      text,
  source_url  text,
  source_app  text,
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
      AND (p_filter_tags IS NULL OR n.tags && p_filter_tags)
      AND (p_filter_since IS NULL OR n.created_at > now() - p_filter_since)
      AND (p_filter_source IS NULL OR n.source = p_filter_source)
    ORDER BY n.embedding <=> p_query_embedding
    LIMIT 50
  ),
  sparse AS (
    SELECT
      n.id,
      ts_rank(n.content_tsv, plainto_tsquery('simple', p_query_text))::real AS s
    FROM public.context_nodes n
    WHERE n.content_tsv @@ plainto_tsquery('simple', p_query_text)
      AND (p_filter_tags IS NULL OR n.tags && p_filter_tags)
      AND (p_filter_since IS NULL OR n.created_at > now() - p_filter_since)
      AND (p_filter_source IS NULL OR n.source = p_filter_source)
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
