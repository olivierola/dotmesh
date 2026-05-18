-- Migration: cron schedules for the three core agents.
-- Same gating pattern as 20260517000002_cron_jobs.sql: skip silently if
-- pg_cron/pg_net or the Vault secrets aren't set.

DO $$
DECLARE
  has_cron boolean;
  has_net  boolean;
  project_url text;
  service_key text;
BEGIN
  SELECT exists(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO has_cron;
  SELECT exists(SELECT 1 FROM pg_extension WHERE extname = 'pg_net')  INTO has_net;
  IF NOT has_cron OR NOT has_net THEN
    RAISE NOTICE 'pg_cron or pg_net missing — agent cron jobs skipped.';
    RETURN;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO project_url
      FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1;
    SELECT decrypted_secret INTO service_key
      FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    project_url := NULL;
  END;
  IF project_url IS NULL OR service_key IS NULL THEN
    RAISE NOTICE 'Vault secrets missing — agent cron jobs skipped.';
    RETURN;
  END IF;

  -- Daily Briefing — 6 UTC every day for all users that didn't disable it
  PERFORM cron.schedule(
    'mesh-agent-daily-briefing',
    '0 6 * * *',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := jsonb_build_object('user_id', u.id, 'triggered_by', 'cron'),
        timeout_milliseconds := 60000
      )
      FROM public.users u
      WHERE u.deleted_at IS NULL
        AND COALESCE(((u.agent_prefs->'daily_briefing')->>'enabled')::boolean, true) = true;
      $cmd$,
      project_url || '/functions/v1/agents-daily-briefing',
      'Bearer ' || service_key
    )
  );

  -- Follow-up agent — Monday + Thursday 8 UTC for paid tiers
  PERFORM cron.schedule(
    'mesh-agent-follow-up',
    '0 8 * * 1,4',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := jsonb_build_object('user_id', u.id, 'triggered_by', 'cron'),
        timeout_milliseconds := 60000
      )
      FROM public.users u
      WHERE u.deleted_at IS NULL
        AND u.tier IN ('personal','pro')
        AND COALESCE(((u.agent_prefs->'follow_up')->>'enabled')::boolean, true) = true;
      $cmd$,
      project_url || '/functions/v1/agents-follow-up',
      'Bearer ' || service_key
    )
  );

  -- Meeting prep — every 5 minutes, only for users with active Calendar
  PERFORM cron.schedule(
    'mesh-agent-meeting-prep',
    '*/5 * * * *',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := jsonb_build_object('user_id', u.id, 'triggered_by', 'cron'),
        timeout_milliseconds := 60000
      )
      FROM public.users u
      INNER JOIN public.connectors c
        ON c.user_id = u.id AND c.provider = 'gcal' AND c.status = 'active'
      WHERE u.deleted_at IS NULL
        AND u.tier IN ('personal','pro')
        AND COALESCE(((u.agent_prefs->'meeting_prep')->>'enabled')::boolean, true) = true;
      $cmd$,
      project_url || '/functions/v1/agents-meeting-prep',
      'Bearer ' || service_key
    )
  );

  RAISE NOTICE 'Agent cron jobs scheduled.';
END $$;
