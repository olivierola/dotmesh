-- Migration: extend weekly_insights with extracted-aware aggregates.
--
-- Until now Insights only surfaced entity-derived themes & people. With
-- canonical metadata.extracted in place, we can show much richer signals
-- without any LLM cost:
--   - top_authors:     who you read this week
--   - top_sites:       where you spent attention (site_name / source_app)
--   - type_breakdown:  how you captured (text vs image vs video vs link)
--   - top_keywords:    aggregated keywords from extracted.keywords
--
-- All four are plain jsonb columns shaped like [{label, count}], same as
-- the existing themes/people for symmetry on the frontend.

BEGIN;

ALTER TABLE public.weekly_insights
  ADD COLUMN IF NOT EXISTS top_authors    jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS top_sites      jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS type_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS top_keywords   jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;
