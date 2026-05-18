-- pgTAP RLS tests for context_rules and connectors

BEGIN;
SELECT plan(8);

SET ROLE postgres;

INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'carla@test.com', '{}'::jsonb),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'dan@test.com', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.context_rules (user_id, rule_type, target, action, filter, priority)
VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'agent_acl', 'chatgpt.com', 'deny', '{"tags":["health"]}'::jsonb, 100),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'tag_block', 'global',      'deny', '{"tags":["finance"]}'::jsonb, 200);

INSERT INTO public.connectors (user_id, provider, status, scopes)
VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'gmail', 'active', ARRAY['readonly']),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'slack', 'active', ARRAY['channels:read']);

-- ============ Carla ============
SELECT public.test_set_user('cccccccc-cccc-cccc-cccc-cccccccccccc');

SELECT is(
  (SELECT count(*)::int FROM public.context_rules),
  1,
  'Carla sees only her 1 rule'
);

SELECT is(
  (SELECT target FROM public.context_rules LIMIT 1),
  'chatgpt.com',
  'Carla rule target correct'
);

-- Carla cannot read Dan rules
SELECT is(
  (SELECT count(*)::int FROM public.context_rules WHERE user_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'),
  0,
  'Carla cannot read Dan rules'
);

-- Carla cannot insert rule for Dan
SELECT throws_ok(
  $$ INSERT INTO public.context_rules (user_id, rule_type, target, action)
     VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'agent_acl', 'evil.com', 'deny') $$,
  NULL,
  'Carla cannot insert rules for Dan'
);

-- Carla cannot read Dan connector
SELECT is(
  (SELECT count(*)::int FROM public.connectors WHERE provider = 'slack'),
  0,
  'Carla cannot see Dan slack connector'
);

-- ============ Dan ============
SELECT public.test_set_user('dddddddd-dddd-dddd-dddd-dddddddddddd');

SELECT is(
  (SELECT count(*)::int FROM public.connectors),
  1,
  'Dan sees only his 1 connector'
);

SELECT is(
  (SELECT provider FROM public.connectors LIMIT 1),
  'slack',
  'Dan connector provider correct'
);

-- Dan can delete his own
DELETE FROM public.connectors WHERE provider = 'slack';
SELECT is(
  (SELECT count(*)::int FROM public.connectors),
  0,
  'Dan can delete his own connector'
);

SELECT * FROM finish();
ROLLBACK;
