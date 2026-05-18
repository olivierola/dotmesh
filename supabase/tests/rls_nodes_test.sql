-- pgTAP RLS tests for context_nodes
-- Verifies that users cannot read/write/delete nodes belonging to other users.

BEGIN;
SELECT plan(10);

-- Setup: two synthetic users in auth.users (RLS bypassed under service_role)
SET ROLE postgres;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@test.com', '{}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.com', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- The on_auth_user_created trigger should have inserted public.users rows.
-- Verify.
SELECT is(
  (SELECT count(*)::int FROM public.users WHERE id IN (
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222'
  )),
  2,
  'Trigger created public.users rows for both auth.users'
);

INSERT INTO public.context_nodes (user_id, content, fingerprint, source)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'Alice note A', 'fp-alice-1', 'manual'),
  ('11111111-1111-1111-1111-111111111111', 'Alice note B', 'fp-alice-2', 'manual'),
  ('22222222-2222-2222-2222-222222222222', 'Bob note',     'fp-bob-1',   'manual');

-- ============ Act as Alice ============
SELECT public.test_set_user('11111111-1111-1111-1111-111111111111');

SELECT is(
  (SELECT count(*)::int FROM public.context_nodes),
  2,
  'Alice sees her own 2 nodes'
);

SELECT is(
  (SELECT count(*)::int FROM public.context_nodes WHERE user_id = '22222222-2222-2222-2222-222222222222'),
  0,
  'Alice cannot see Bob nodes via filter'
);

-- Try to INSERT a row for Bob (should fail RLS WITH CHECK)
SELECT throws_ok(
  $$ INSERT INTO public.context_nodes (user_id, content, fingerprint, source)
     VALUES ('22222222-2222-2222-2222-222222222222', 'malicious', 'fp-mal', 'manual') $$,
  NULL,
  'Alice cannot insert nodes for Bob'
);

-- Try to UPDATE Bob nodes (should affect zero rows due to USING)
SET ROLE postgres;
SELECT is(
  (SELECT count(*)::int FROM public.context_nodes WHERE content = 'Bob note'),
  1,
  'Bob node still exists before update attempt'
);

SELECT public.test_set_user('11111111-1111-1111-1111-111111111111');
UPDATE public.context_nodes SET content = 'hijacked' WHERE content = 'Bob note';

SET ROLE postgres;
SELECT is(
  (SELECT content FROM public.context_nodes WHERE fingerprint = 'fp-bob-1'),
  'Bob note',
  'Bob node content unchanged after Alice update attempt'
);

-- Try to DELETE Bob nodes
SELECT public.test_set_user('11111111-1111-1111-1111-111111111111');
DELETE FROM public.context_nodes WHERE content = 'Bob note';

SET ROLE postgres;
SELECT is(
  (SELECT count(*)::int FROM public.context_nodes WHERE fingerprint = 'fp-bob-1'),
  1,
  'Bob node still exists after Alice delete attempt'
);

-- ============ Act as Bob ============
SELECT public.test_set_user('22222222-2222-2222-2222-222222222222');

SELECT is(
  (SELECT count(*)::int FROM public.context_nodes),
  1,
  'Bob sees only his 1 node'
);

SELECT is(
  (SELECT content FROM public.context_nodes LIMIT 1),
  'Bob note',
  'Bob sees the correct content'
);

-- Bob can update his own
UPDATE public.context_nodes SET content = 'Bob note edited' WHERE fingerprint = 'fp-bob-1';

SELECT is(
  (SELECT content FROM public.context_nodes WHERE fingerprint = 'fp-bob-1'),
  'Bob note edited',
  'Bob can edit his own nodes'
);

-- Bob can delete his own
DELETE FROM public.context_nodes WHERE fingerprint = 'fp-bob-1';

SELECT is(
  (SELECT count(*)::int FROM public.context_nodes WHERE fingerprint = 'fp-bob-1'),
  0,
  'Bob can delete his own nodes'
);

SELECT * FROM finish();
ROLLBACK;
