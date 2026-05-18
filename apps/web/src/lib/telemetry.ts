/**
 * Sentry + PostHog initialization.
 * Both are silently skipped if env vars are missing — so dev works without keys.
 */

import * as Sentry from '@sentry/react';
import posthog from 'posthog-js';

const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const POSTHOG_HOST =
  (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://eu.i.posthog.com';

let initialized = false;

export function initTelemetry(): void {
  if (initialized) return;
  initialized = true;

  if (SENTRY_DSN) {
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: import.meta.env.MODE,
      tracesSampleRate: 0.2,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0.5,
    });
  }

  if (POSTHOG_KEY) {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: 'history_change',
      autocapture: true,
      persistence: 'localStorage+cookie',
      disable_session_recording: true, // privacy-first; opt-in later
    });
  }
}

export function identifyUser(userId: string, traits: Record<string, unknown> = {}): void {
  if (POSTHOG_KEY) {
    posthog.identify(userId, traits);
  }
  if (SENTRY_DSN) {
    Sentry.setUser({ id: userId, ...traits });
  }
}

export function track(event: string, props: Record<string, unknown> = {}): void {
  if (POSTHOG_KEY) {
    posthog.capture(event, props);
  }
}

export function captureError(err: unknown, context: Record<string, unknown> = {}): void {
  if (SENTRY_DSN) {
    Sentry.captureException(err, { extra: context });
  } else {
    // eslint-disable-next-line no-console
    console.error('[telemetry]', err, context);
  }
}
