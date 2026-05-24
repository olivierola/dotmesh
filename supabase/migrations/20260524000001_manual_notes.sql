-- Manual notes feature.
--
-- Notes are stored as rows in context_nodes (so they get embeddings,
-- search, collections, and existing edges for free) with:
--   source       = 'manual_note'
--   node_type    = 'note'
--   content      = full markdown body (raw, with [[wiki-links]])
--   summary      = note title (first line / explicit), used as the title
--   metadata.note_title  = explicit user-set title (overrides summary)
--   metadata.note_html   = TipTap-rendered HTML cached for display
--
-- Wiki-links between notes become rows in context_edges with
-- relation_type='note_link', so the graph renders them with a distinct
-- visual.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Add 'note_link' to the allowed relation_type values.
-- ---------------------------------------------------------------------

ALTER TABLE public.context_edges
  DROP CONSTRAINT IF EXISTS context_edges_relation_type_check;

ALTER TABLE public.context_edges
  ADD CONSTRAINT context_edges_relation_type_check
  CHECK (relation_type IN (
    'inferred',
    'explicit',
    'temporal',
    'contradicts',
    'supersedes',
    'user_linked',
    'belongs_to_page',
    'navigated_from',
    'same_session',
    'mentions',
    'extends',
    'cites',
    'note_link'
  ));

-- ---------------------------------------------------------------------
-- 2. Index to make "list all notes" fast.
-- ---------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_context_nodes_user_notes
  ON public.context_nodes (user_id, created_at DESC)
  WHERE source = 'manual_note';

-- ---------------------------------------------------------------------
-- 3. Hub-node bookkeeping (Phase 2 will populate this with the central
--    "Me" hub + per-collection sub-hubs). Added here so the schema is
--    ready and we don't need a second migration.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.graph_hubs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('me', 'collection')),
  label         text NOT NULL,
  -- For kind='collection' this references collections.id; null for 'me'.
  collection_id uuid REFERENCES public.collections(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, collection_id)
);

CREATE INDEX IF NOT EXISTS idx_graph_hubs_user ON public.graph_hubs (user_id);

ALTER TABLE public.graph_hubs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS graph_hubs_owner_all ON public.graph_hubs;
CREATE POLICY graph_hubs_owner_all ON public.graph_hubs
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMIT;
