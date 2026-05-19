-- Migration: richer edge types so the graph becomes a real second brain.
--
-- Adds:
--   - belongs_to_page  : a captured snippet is a child of a "page" node
--                        (one page node per source_url, holds the page meta).
--   - navigated_from   : the user opened this page from another previously
--                        captured page (document.referrer chain).
--   - same_session     : two captures happened inside the same browsing
--                        session window (~20 min sliding).
--   - mentions, extends, cites: declared by an LLM after looking at the
--                        new node and its semantic neighbours.
--
-- These coexist with the existing inferred/explicit/temporal/contradicts/
-- supersedes/user_linked types.
--
-- Also adds a recursive view ancestors_of / descendants_of so the
-- frontend can walk arbitrary depth without re-querying.

BEGIN;

-- Relax the relation_type CHECK to allow the new values. We drop and
-- re-add because CHECK constraints don't support direct ALTER.
ALTER TABLE public.context_edges DROP CONSTRAINT IF EXISTS context_edges_relation_type_check;
ALTER TABLE public.context_edges
  ADD CONSTRAINT context_edges_relation_type_check
  CHECK (relation_type IN (
    'inferred',
    'explicit',
    'temporal',
    'contradicts',
    'supersedes',
    'user_linked',
    -- New hierarchical / navigational types
    'belongs_to_page',
    'navigated_from',
    'same_session',
    -- New LLM-declared semantic types
    'mentions',
    'extends',
    'cites'
  ));

-- ----------------------------------------------------------------
-- Recursive view: ancestors_of(node_id) → all transitive parents
-- through `belongs_to_page` + `navigated_from`.
-- ----------------------------------------------------------------
-- A node can have multiple parents (a page belongs to itself, and the
-- captured paragraph belongs to that page, and the page can have a
-- navigated_from parent, etc.) so we expose a function returning the
-- full set with a depth column.

CREATE OR REPLACE FUNCTION public.node_ancestors(p_node_id uuid)
RETURNS TABLE (
  node_id  uuid,
  depth    integer,
  via      text
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH RECURSIVE walk AS (
    SELECT e.from_node AS node_id, 1 AS depth, e.relation_type AS via
    FROM public.context_edges e
    WHERE e.to_node = p_node_id
      AND e.relation_type IN ('belongs_to_page', 'navigated_from')
    UNION ALL
    SELECT e.from_node, w.depth + 1, e.relation_type
    FROM public.context_edges e
    JOIN walk w ON e.to_node = w.node_id
    WHERE e.relation_type IN ('belongs_to_page', 'navigated_from')
      AND w.depth < 8 -- safety cap
  )
  SELECT DISTINCT node_id, min(depth) AS depth, string_agg(DISTINCT via, ',') AS via
  FROM walk
  GROUP BY node_id;
$$;

CREATE OR REPLACE FUNCTION public.node_descendants(p_node_id uuid)
RETURNS TABLE (
  node_id  uuid,
  depth    integer,
  via      text
)
LANGUAGE sql STABLE SECURITY INVOKER
AS $$
  WITH RECURSIVE walk AS (
    SELECT e.to_node AS node_id, 1 AS depth, e.relation_type AS via
    FROM public.context_edges e
    WHERE e.from_node = p_node_id
      AND e.relation_type IN ('belongs_to_page', 'navigated_from')
    UNION ALL
    SELECT e.to_node, w.depth + 1, e.relation_type
    FROM public.context_edges e
    JOIN walk w ON e.from_node = w.node_id
    WHERE e.relation_type IN ('belongs_to_page', 'navigated_from')
      AND w.depth < 8
  )
  SELECT DISTINCT node_id, min(depth) AS depth, string_agg(DISTINCT via, ',') AS via
  FROM walk
  GROUP BY node_id;
$$;

GRANT EXECUTE ON FUNCTION public.node_ancestors(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.node_descendants(uuid) TO authenticated, service_role;

COMMIT;
