-- Migration: required extensions
--
-- On Supabase Cloud, vector / pgcrypto / pg_trgm / uuid-ossp are pre-installed
-- and just need to be enabled in your project.
--
-- pgmq and pg_cron must be enabled FROM THE DASHBOARD before this migration runs:
--   Database → Extensions → enable pgmq, pg_cron
-- This file is idempotent: it tries to CREATE EXTENSION and continues if any fail.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Optional extensions; only available if enabled in the dashboard.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS "pgmq";
    RAISE NOTICE 'pgmq enabled.';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgmq not available — connector queue features will be skipped.';
  END;

  BEGIN
    CREATE EXTENSION IF NOT EXISTS "pg_cron";
    RAISE NOTICE 'pg_cron enabled.';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron not available — cron jobs must be scheduled manually.';
  END;

  BEGIN
    CREATE EXTENSION IF NOT EXISTS "pg_net";
    RAISE NOTICE 'pg_net enabled.';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_net not available — cron jobs that POST to Edge Functions will fail.';
  END;
END $$;
