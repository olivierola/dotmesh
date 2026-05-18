-- Migration: context_edges — graph relationships between nodes

CREATE TABLE public.context_edges (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  from_node       uuid NOT NULL REFERENCES public.context_nodes(id) ON DELETE CASCADE,
  to_node         uuid NOT NULL REFERENCES public.context_nodes(id) ON DELETE CASCADE,
  relation_type   text NOT NULL
                    CHECK (relation_type IN
                      ('inferred','explicit','temporal','contradicts','supersedes','user_linked')),
  confidence      real CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 1)),
  shared_entity   text,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT no_self_edge CHECK (from_node <> to_node)
);

CREATE INDEX idx_edges_user_from   ON public.context_edges (user_id, from_node);
CREATE INDEX idx_edges_user_to     ON public.context_edges (user_id, to_node);
CREATE INDEX idx_edges_relation    ON public.context_edges (user_id, relation_type);
CREATE UNIQUE INDEX idx_edges_unique
  ON public.context_edges (user_id, from_node, to_node, relation_type);

-- RLS
ALTER TABLE public.context_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY edges_select_own ON public.context_edges
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY edges_insert_own ON public.context_edges
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY edges_update_own ON public.context_edges
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY edges_delete_own ON public.context_edges
  FOR DELETE USING (user_id = auth.uid());
