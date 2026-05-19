-- Mesh — reset all captured nodes for the current authenticated user.
--
-- Run this from the Supabase SQL Editor while you are signed in as the user
-- whose data you want to wipe. RLS scopes everything to auth.uid().
--
-- WHAT IS DELETED:
--   - context_nodes (cascades to context_edges + node_collections)
--   - audit_log entries about those nodes
--   - injections that referenced them
--
-- WHAT IS PRESERVED:
--   - your user row, profile, subscription tier
--   - your collections (including auto-generated ones)
--   - your rules, connectors, embed tokens, chat sessions
--
-- After running this, re-capture a few memories and verify:
--   SELECT id, summary, embedding IS NOT NULL AS has_embedding
--   FROM context_nodes ORDER BY created_at DESC LIMIT 5;
-- "has_embedding" should be true once JINA_API_KEY is configured.

BEGIN;

-- 1. Audit log entries that reference user's nodes
DELETE FROM audit_log
WHERE user_id = auth.uid()
  AND operation IN ('node.create', 'node.update', 'node.delete');

-- 2. Injections (logged inject decisions referencing nodes)
DELETE FROM injections WHERE user_id = auth.uid();

-- 3. The nodes themselves. ON DELETE CASCADE handles edges + node_collections.
DELETE FROM context_nodes WHERE user_id = auth.uid();

-- 4. Sanity-check the result
SELECT
  (SELECT count(*) FROM context_nodes WHERE user_id = auth.uid()) AS remaining_nodes,
  (SELECT count(*) FROM context_edges WHERE user_id = auth.uid()) AS remaining_edges,
  (SELECT count(*) FROM node_collections WHERE user_id = auth.uid()) AS remaining_memberships;

COMMIT;
