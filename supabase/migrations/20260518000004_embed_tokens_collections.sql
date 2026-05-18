-- Migration: scope embed tokens to specific collections.
-- Empty array = all collections (legacy behaviour).

ALTER TABLE public.embed_tokens
  ADD COLUMN IF NOT EXISTS collection_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.embed_tokens.collection_ids IS
  'When non-empty, the token can only query nodes in these collections. Empty = unrestricted.';
