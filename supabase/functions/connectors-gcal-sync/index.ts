/**
 * Google Calendar sync worker.
 * Fetches upcoming events (next 30 days) for the user's primary calendar.
 * Idempotent via fingerprint on event id + updated timestamp.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { loadTokens, updateSyncState, storeTokens } from '../_shared/connectors.ts';

const GCAL = 'https://www.googleapis.com/calendar/v3';

interface SyncInput {
  user_id: string;
}

interface GCalEvent {
  id: string;
  status: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>;
  organizer?: { email: string; displayName?: string };
  htmlLink?: string;
  updated?: string;
}

async function refresh(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  tokens: NonNullable<Awaited<ReturnType<typeof loadTokens>>>,
): Promise<typeof tokens> {
  if (tokens.expires_at > Date.now() + 60_000) return tokens;
  if (!tokens.refresh_token) throw new Error('no_refresh_token');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });
  if (!res.ok) throw new Error(`refresh_failed:${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  const fresh = {
    ...tokens,
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  await storeTokens(service, userId, 'gcal', fresh);
  return fresh;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function formatEvent(ev: GCalEvent): string {
  const when = ev.start?.dateTime ?? ev.start?.date ?? '?';
  const attendees =
    ev.attendees
      ?.map((a) => a.displayName ?? a.email)
      .filter(Boolean)
      .slice(0, 8)
      .join(', ') ?? '';
  const lines = [
    `[Calendar event] ${ev.summary ?? '(no title)'}`,
    `When: ${when}`,
    ev.location ? `Where: ${ev.location}` : '',
    attendees ? `Attendees: ${attendees}` : '',
    ev.description ? `\n${ev.description.slice(0, 1500)}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`) {
    return errorResponse('forbidden', 403);
  }

  try {
    const { user_id } = await parseJsonBody<SyncInput>(req);
    const service = createServiceClient();
    const tokens = await loadTokens(service, user_id, 'gcal');
    if (!tokens) return errorResponse('connector_not_found', 404);
    const fresh = await refresh(service, user_id, tokens);

    const now = new Date();
    const horizon = new Date(now.getTime() + 30 * 86400_000);
    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: horizon.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '50',
    });
    const res = await fetch(`${GCAL}/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${fresh.access_token}` },
    });
    if (!res.ok) {
      await updateSyncState(service, user_id, 'gcal', null, 'error', `gcal_${res.status}`);
      return errorResponse('gcal_failed', 502);
    }
    const data = (await res.json()) as { items?: GCalEvent[] };

    let imported = 0;
    for (const ev of data.items ?? []) {
      if (ev.status === 'cancelled') continue;
      const content = formatEvent(ev);
      const fingerprint = await sha256Hex(`gcal|${ev.id}|${ev.updated ?? ''}`);
      const { data: inserted } = await service
        .from('context_nodes')
        .upsert(
          {
            user_id,
            source: 'connector:gcal',
            source_url: ev.htmlLink ?? null,
            source_app: 'gcal',
            content,
            tags: ['calendar', 'event'],
            acl_agents: ['*'],
            fingerprint,
            metadata: {
              event_id: ev.id,
              start: ev.start,
              attendees_count: ev.attendees?.length ?? 0,
            },
          },
          { onConflict: 'user_id,fingerprint', ignoreDuplicates: true },
        )
        .select('id')
        .maybeSingle();
      if (inserted?.id) {
        imported++;
        fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/process-node`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ node_id: inserted.id }),
        }).catch(() => {});
      }
    }
    await updateSyncState(service, user_id, 'gcal', null);
    return jsonResponse({ ok: true, imported });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('gcal-sync error', e);
    return errorResponse('internal_error', 500);
  }
});
