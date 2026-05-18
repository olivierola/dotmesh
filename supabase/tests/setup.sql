-- pgTAP setup. Install via:
--   CREATE EXTENSION pgtap;
-- Run a single test:
--   psql -f supabase/tests/rls_nodes_test.sql
-- Or via Supabase CLI:
--   supabase test db

CREATE EXTENSION IF NOT EXISTS pgtap;

-- Test helper: act as a given user_id (sets JWT claims for RLS).
CREATE OR REPLACE FUNCTION public.test_set_user(p_user_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
    true);
  PERFORM set_config('request.jwt.claim.sub', p_user_id::text, true);
  PERFORM set_config('role', 'authenticated', true);
END;
$$;

-- Reset to service_role (bypasses RLS).
CREATE OR REPLACE FUNCTION public.test_reset_role() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
END;
$$;
