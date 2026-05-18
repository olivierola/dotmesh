-- Migration: explicit-user-scoped hybrid search.
-- Used by embed-ask (runs as service_role, so we can't rely on auth.uid()).

CREATE OR REPLACE FUNCTION public.hybrid_search_for_user(
  p_user_id          uuid,
  p_query_text       text,
  p_query_embedding  vector(1024),
  p_top_k            integer DEFAULT 5
)
RETURNS TABLE (
  id          uuid,
  content     text,
  summary     text,
  source      text,
  source_url  text,
  created_at  timestamptz,
  score       real
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  WITH dense AS (
    SELECT n.id, (1 - (n.embedding <=> p_query_embedding))::real AS s
    FROM public.context_nodes n
    WHERE n.user_id = p_user_id AND n.embedding IS NOT NULL
    ORDER BY n.embedding <=> p_query_embedding
    LIMIT 50
  ),
  sparse AS (
    SELECT n.id,
           ts_rank(n.content_tsv, plainto_tsquery('simple', p_query_text))::real AS s
    FROM public.context_nodes n
    WHERE n.user_id = p_user_id
      AND n.content_tsv @@ plainto_tsquery('simple', p_query_text)
    LIMIT 50
  ),
  combined AS (
    SELECT COALESCE(d.id, s.id) AS id,
           (COALESCE(d.s, 0) * 0.7 + COALESCE(s.s, 0) * 0.3)::real AS final_score
    FROM dense d FULL OUTER JOIN sparse s USING (id)
  )
  SELECT n.id, n.content, n.summary, n.source, n.source_url, n.created_at, c.final_score
  FROM combined c
  JOIN public.context_nodes n ON n.id = c.id
  WHERE n.user_id = p_user_id
  ORDER BY c.final_score DESC
  LIMIT p_top_k;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.hybrid_search_for_user(uuid, text, vector, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hybrid_search_for_user(uuid, text, vector, integer) TO service_role;
