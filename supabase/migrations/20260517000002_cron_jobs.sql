-- Migration: pg_cron schedules for background jobs.
--
-- Requirements (set in Supabase Cloud before running this migration):
--   1. Extensions: pg_cron, pg_net (enable from dashboard)
--   2. Vault secrets:
--      - project_url        : your project URL, e.g. https://abc.supabase.co
--      - service_role_key   : the service role JWT (Settings → API)
--
-- If any of these are missing, the migration logs a notice and skips. Re-run
-- after setting them to install the schedules.

DO $$
DECLARE
  has_cron boolean;
  has_net  boolean;
  project_url text;
  service_key text;
BEGIN
  SELECT exists(SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') INTO has_cron;
  SELECT exists(SELECT 1 FROM pg_extension WHERE extname = 'pg_net')  INTO has_net;

  IF NOT has_cron THEN
    RAISE NOTICE 'pg_cron not installed — skipping cron schedules.';
    RETURN;
  END IF;

  -- Always-on jobs (no HTTP needed)
  PERFORM cron.schedule(
    'mesh-cleanup-ttl',
    '*/15 * * * *',
    $cmd$ DELETE FROM public.context_nodes WHERE ttl_at IS NOT NULL AND ttl_at < now(); $cmd$
  );

  PERFORM cron.schedule(
    'mesh-free-tier-fifo',
    '0 3 * * *',
    $cmd$
    WITH ranked AS (
      SELECT n.id,
             row_number() OVER (PARTITION BY n.user_id ORDER BY n.created_at DESC) AS rn
      FROM public.context_nodes n
      JOIN public.users u ON u.id = n.user_id
      WHERE u.tier = 'free' AND n.pinned = false
    )
    DELETE FROM public.context_nodes WHERE id IN (SELECT id FROM ranked WHERE rn > 1000);
    $cmd$
  );

  -- HTTP-based jobs require pg_net + Vault secrets
  IF NOT has_net THEN
    RAISE NOTICE 'pg_net not installed — HTTP-based cron jobs skipped.';
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
    RAISE NOTICE 'Vault secrets project_url / service_role_key missing — HTTP cron jobs skipped.';
    RETURN;
  END IF;

  -- Hard wipe of accounts past the 72h grace period
  PERFORM cron.schedule(
    'mesh-account-wipe',
    '0 * * * *',
    format(
      $cmd$ SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      ); $cmd$,
      project_url || '/functions/v1/account-wipe-worker',
      'Bearer ' || service_key
    )
  );

  -- Connector sync — Gmail
  PERFORM cron.schedule(
    'mesh-sync-gmail',
    '*/10 * * * *',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := jsonb_build_object('user_id', c.user_id),
        timeout_milliseconds := 60000
      )
      FROM public.connectors c
      WHERE c.status = 'active' AND c.provider = 'gmail'
        AND (c.last_sync_at IS NULL OR c.last_sync_at < now() - interval '10 minutes');
      $cmd$,
      project_url || '/functions/v1/connectors-gmail-sync',
      'Bearer ' || service_key
    )
  );

  -- Connector sync — Google Calendar
  PERFORM cron.schedule(
    'mesh-sync-gcal',
    '*/15 * * * *',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := jsonb_build_object('user_id', c.user_id),
        timeout_milliseconds := 60000
      )
      FROM public.connectors c
      WHERE c.status = 'active' AND c.provider = 'gcal'
        AND (c.last_sync_at IS NULL OR c.last_sync_at < now() - interval '15 minutes');
      $cmd$,
      project_url || '/functions/v1/connectors-gcal-sync',
      'Bearer ' || service_key
    )
  );

  -- Connector sync — Slack
  PERFORM cron.schedule(
    'mesh-sync-slack',
    '*/10 * * * *',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := jsonb_build_object('user_id', c.user_id),
        timeout_milliseconds := 60000
      )
      FROM public.connectors c
      WHERE c.status = 'active' AND c.provider = 'slack'
        AND (c.last_sync_at IS NULL OR c.last_sync_at < now() - interval '10 minutes');
      $cmd$,
      project_url || '/functions/v1/connectors-slack-sync',
      'Bearer ' || service_key
    )
  );

  -- Connector sync — Notion
  PERFORM cron.schedule(
    'mesh-sync-notion',
    '*/15 * * * *',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := jsonb_build_object('user_id', c.user_id),
        timeout_milliseconds := 60000
      )
      FROM public.connectors c
      WHERE c.status = 'active' AND c.provider = 'notion'
        AND (c.last_sync_at IS NULL OR c.last_sync_at < now() - interval '15 minutes');
      $cmd$,
      project_url || '/functions/v1/connectors-notion-sync',
      'Bearer ' || service_key
    )
  );

  -- Webhook delivery worker — every minute
  PERFORM cron.schedule(
    'mesh-webhook-deliver',
    '* * * * *',
    format(
      $cmd$ SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      ); $cmd$,
      project_url || '/functions/v1/webhooks-deliver',
      'Bearer ' || service_key
    )
  );

  -- Weekly insights — Monday 9 UTC
  PERFORM cron.schedule(
    'mesh-weekly-insights',
    '0 9 * * 1',
    format(
      $cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object('Authorization', %L, 'Content-Type', 'application/json'),
        body := jsonb_build_object('user_id', u.id),
        timeout_milliseconds := 60000
      )
      FROM public.users u
      WHERE u.tier IN ('personal','pro') AND u.deleted_at IS NULL;
      $cmd$,
      project_url || '/functions/v1/insights-generate',
      'Bearer ' || service_key
    )
  );

  RAISE NOTICE 'All cron jobs scheduled.';
END $$;
