-- Migration: per-user notification + UI preferences.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT jsonb_build_object(
    'weekly_digest_email', true,
    'realtime_in_app', true,
    'product_updates', false,
    'security_alerts', true
  ),
  ADD COLUMN IF NOT EXISTS ui_prefs jsonb NOT NULL DEFAULT jsonb_build_object(
    'theme', 'dark',
    'compact_density', false,
    'injection_auto_accept_ms', 2000
  );
