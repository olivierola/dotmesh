/**
 * Minimal Sentry envelope forwarder for Edge Functions.
 *
 * Deno doesn't have an official Sentry SDK that works server-side reliably here,
 * so we POST a minimal event manually. No-op if SENTRY_DSN missing.
 */

const SENTRY_DSN = Deno.env.get('SENTRY_DSN_EDGE') ?? '';

interface ParsedDsn {
  publicKey: string;
  host: string;
  projectId: string;
}

function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    return {
      publicKey: u.username,
      host: u.host,
      projectId: u.pathname.replace(/^\//, ''),
    };
  } catch {
    return null;
  }
}

const parsed = parseDsn(SENTRY_DSN);

export async function reportError(
  err: unknown,
  context: { fn?: string; user_id?: string } = {},
): Promise<void> {
  if (!parsed) {
    console.error('[error]', err, context);
    return;
  }
  const errorPayload = err instanceof Error
    ? { type: err.name, value: err.message, stacktrace: { frames: [] } }
    : { type: 'Error', value: String(err) };

  const event = {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'javascript',
    environment: Deno.env.get('SENTRY_ENV') ?? 'production',
    server_name: 'mesh-edge',
    tags: { function: context.fn ?? 'unknown' },
    user: context.user_id ? { id: context.user_id } : undefined,
    exception: { values: [errorPayload] },
  };

  try {
    await fetch(
      `https://${parsed.host}/api/${parsed.projectId}/store/?sentry_version=7&sentry_key=${parsed.publicKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      },
    );
  } catch (e) {
    console.warn('Sentry post failed', e);
  }
}
