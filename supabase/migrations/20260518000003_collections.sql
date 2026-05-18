-- Migration: collections — user-defined slices of memory.
--
-- A collection is a named subset of the user's nodes, defined by:
--   - description: natural-language explanation of what belongs in it
--   - rules: structured filters derived from the description by an LLM
--
-- Every node is assigned to one or more collections at capture time by a
-- classifier. If nothing matches, the node falls back to the user's default
-- "Inbox" collection (auto-created on signup).
--
-- Collections are used to scope what an embed token / agent / chat can access.

CREATE TABLE public.collections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description   text,
  /** Natural-language rule the user typed (kept for re-classification later). */
  rule_prompt   text,
  /** Structured filter derived from the prompt by the LLM. Shape:
   *  {
   *    "sources":  ["extension", "connector:gmail", ...],     // OR among them
   *    "tags":     ["work", "design"],                         // OR among them
   *    "domains":  ["claude.ai", "notion.so"],                 // matches source_url host
   *    "keywords": ["sophie", "falcon"],                       // matches summary/content (any)
   *    "exclude_tags": ["personal"],                           // hard exclude
   *    "exclude_domains": ["mail.google.com"]
   *  }
   *  All non-empty groups must match (AND between groups, OR within a group).
   */
  filter        jsonb NOT NULL DEFAULT '{}'::jsonb,
  /** When true, this collection collects everything that didn't match any other.
   *  Exactly one such "inbox" collection per user, created on signup. */
  is_default    boolean NOT NULL DEFAULT false,
  /** Display in the grid order; smaller = first. Default = creation order. */
  sort_order    integer NOT NULL DEFAULT 100,
  icon          text,            -- single emoji
  color         text,            -- hex value used as accent on the card
  pinned        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_collections_user ON public.collections (user_id, sort_order);
CREATE UNIQUE INDEX idx_collections_user_default
  ON public.collections (user_id) WHERE is_default = true;

CREATE TRIGGER collections_touch_updated_at
  BEFORE UPDATE ON public.collections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY collections_own ON public.collections
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================
-- Join table: which collections does each node belong to?
-- ============================================================

CREATE TABLE public.node_collections (
  node_id        uuid NOT NULL REFERENCES public.context_nodes(id) ON DELETE CASCADE,
  collection_id  uuid NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  /** "auto" = assigned by classifier, "manual" = pinned by user. */
  source         text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, collection_id)
);

CREATE INDEX idx_node_collections_user ON public.node_collections (user_id);
CREATE INDEX idx_node_collections_collection
  ON public.node_collections (collection_id, created_at DESC);

ALTER TABLE public.node_collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY node_collections_own ON public.node_collections
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ============================================================
-- Auto-create default "Inbox" collection on signup
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_default_collection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.collections (user_id, name, description, is_default, sort_order, icon)
  VALUES (
    NEW.id,
    'Inbox',
    'Everything that doesn''t match another collection.',
    true,
    999,
    '📥'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_user_created_make_inbox
  AFTER INSERT ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.create_default_collection();

-- Backfill for existing users (idempotent — won't dup because of unique index)
DO $$
BEGIN
  INSERT INTO public.collections (user_id, name, description, is_default, sort_order, icon)
  SELECT
    u.id, 'Inbox',
    'Everything that doesn''t match another collection.',
    true, 999, '📥'
  FROM public.users u
  LEFT JOIN public.collections c ON c.user_id = u.id AND c.is_default = true
  WHERE c.id IS NULL AND u.deleted_at IS NULL;
END $$;

-- ============================================================
-- Helper: list collections with stats (node count)
-- ============================================================

CREATE OR REPLACE VIEW public.collections_with_stats AS
SELECT
  c.id,
  c.user_id,
  c.name,
  c.description,
  c.rule_prompt,
  c.filter,
  c.is_default,
  c.sort_order,
  c.icon,
  c.color,
  c.pinned,
  c.created_at,
  c.updated_at,
  COALESCE(stats.node_count, 0) AS node_count,
  stats.last_node_at
FROM public.collections c
LEFT JOIN (
  SELECT
    collection_id,
    count(*) AS node_count,
    max(created_at) AS last_node_at
  FROM public.node_collections
  GROUP BY collection_id
) stats ON stats.collection_id = c.id;

ALTER VIEW public.collections_with_stats SET (security_invoker = true);

-- ============================================================
-- Helper SQL: filter a single node against a collection's `filter`.
-- Returns true if the node matches.
-- ============================================================

CREATE OR REPLACE FUNCTION public.node_matches_filter(
  p_node_id uuid,
  p_filter  jsonb
) RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  n RECORD;
  host text;
  sources       text[];
  tags          text[];
  domains       text[];
  keywords      text[];
  excl_tags     text[];
  excl_domains  text[];
BEGIN
  SELECT source, source_url, tags, summary, content INTO n
  FROM public.context_nodes WHERE id = p_node_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Extract host from source_url for domain matching
  IF n.source_url IS NOT NULL THEN
    BEGIN
      host := lower(split_part(split_part(n.source_url, '://', 2), '/', 1));
    EXCEPTION WHEN OTHERS THEN
      host := NULL;
    END;
  END IF;

  sources      := ARRAY(SELECT jsonb_array_elements_text(coalesce(p_filter->'sources','[]'::jsonb)));
  tags         := ARRAY(SELECT jsonb_array_elements_text(coalesce(p_filter->'tags','[]'::jsonb)));
  domains      := ARRAY(SELECT jsonb_array_elements_text(coalesce(p_filter->'domains','[]'::jsonb)));
  keywords     := ARRAY(SELECT jsonb_array_elements_text(coalesce(p_filter->'keywords','[]'::jsonb)));
  excl_tags    := ARRAY(SELECT jsonb_array_elements_text(coalesce(p_filter->'exclude_tags','[]'::jsonb)));
  excl_domains := ARRAY(SELECT jsonb_array_elements_text(coalesce(p_filter->'exclude_domains','[]'::jsonb)));

  -- Exclusions short-circuit
  IF cardinality(excl_tags) > 0 AND n.tags && excl_tags THEN RETURN false; END IF;
  IF cardinality(excl_domains) > 0 AND host IS NOT NULL THEN
    IF host = ANY(excl_domains) THEN RETURN false; END IF;
  END IF;

  -- Inclusions (AND between groups, OR within)
  IF cardinality(sources) > 0 AND NOT (n.source = ANY(sources)) THEN RETURN false; END IF;
  IF cardinality(tags) > 0 AND NOT (n.tags && tags) THEN RETURN false; END IF;
  IF cardinality(domains) > 0 THEN
    IF host IS NULL OR NOT (host = ANY(domains)) THEN RETURN false; END IF;
  END IF;
  IF cardinality(keywords) > 0 THEN
    DECLARE
      hay text := lower(coalesce(n.summary,'') || ' ' || coalesce(n.content,''));
      kw  text;
      ok  boolean := false;
    BEGIN
      FOREACH kw IN ARRAY keywords LOOP
        IF position(lower(kw) in hay) > 0 THEN ok := true; EXIT; END IF;
      END LOOP;
      IF NOT ok THEN RETURN false; END IF;
    END;
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION public.node_matches_filter(uuid, jsonb) TO authenticated, service_role;
