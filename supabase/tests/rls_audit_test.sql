-- pgTAP RLS tests for audit_log (immutability)

BEGIN;
SELECT plan(6);

SET ROLE postgres;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'alice2@test.com', '{}'::jsonb),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bob2@test.com', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.audit_log (user_id, operation, metadata)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'node.create', '{"ip":"x"}'::jsonb),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'node.delete', '{}'::jsonb),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'injection',   '{}'::jsonb);

-- Act as Alice
SELECT public.test_set_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

SELECT is(
  (SELECT count(*)::int FROM public.audit_log),
  2,
  'Alice sees only her audit entries'
);

-- Alice cannot INSERT as authenticated (only service_role policy allows insert)
SELECT throws_ok(
  $$ INSERT INTO public.audit_log (user_id, operation) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'fake') $$,
  NULL,
  'Authenticated users cannot INSERT into audit_log'
);

-- Alice cannot UPDATE (no policy at all)
SELECT public.test_set_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
UPDATE public.audit_log SET operation = 'tampered' WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

SET ROLE postgres;
SELECT is(
  (SELECT count(*)::int FROM public.audit_log WHERE operation = 'tampered'),
  0,
  'UPDATE on audit_log is blocked (no policy)'
);

-- Alice cannot DELETE
SELECT public.test_set_user('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
DELETE FROM public.audit_log WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

SET ROLE postgres;
SELECT is(
  (SELECT count(*)::int FROM public.audit_log WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  2,
  'DELETE on audit_log is blocked (no policy)'
);

-- Bob cannot see Alice rows
SELECT public.test_set_user('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
SELECT is(
  (SELECT count(*)::int FROM public.audit_log WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0,
  'Bob cannot read Alice audit entries'
);

SELECT is(
  (SELECT count(*)::int FROM public.audit_log),
  1,
  'Bob sees only his 1 audit entry'
);

SELECT * FROM finish();
ROLLBACK;
