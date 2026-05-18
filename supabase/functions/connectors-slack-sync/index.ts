/**
 * Slack sync worker.
 *
 * Reads messages from channels the user has explicitly opted in via
 * connector.sync_settings.channels: string[].
 *
 * DMs are excluded by default. Messages older than the connector's last_sync_at
 * are skipped (incremental sync via `oldest` parameter).
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { loadTokens, updateSyncState } from '../_shared/connectors.ts';

const SLACK_API = 'https://slack.com/api';

interface SyncInput {
  user_id: string;
}

interface SlackMessage {
  ts: string; // unix.microseconds — string
  user?: string;
  text: string;
  thread_ts?: string;
  subtype?: string;
  permalink?: string;
}

async function fetchSlack<T>(
  token: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T | null> {
  const url = new URL(`${SLACK_API}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { ok: boolean } & T;
  if (!data.ok) {
    console.warn('slack api error', path, (data as unknown as { error?: string }).error);
    return null;
  }
  return data;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
    const tokens = await loadTokens(service, user_id, 'slack');
    if (!tokens) return errorResponse('connector_not_found', 404);

    const { data: conn } = await service
      .from('connectors')
      .select('sync_settings, last_sync_at')
      .eq('user_id', user_id)
      .eq('provider', 'slack')
      .maybeSingle();

    const settings = (conn?.sync_settings ?? {}) as {
      channels?: string[];
      exclude_dms?: boolean;
    };
    const channels = settings.channels ?? [];
    if (channels.length === 0) {
      await updateSyncState(service, user_id, 'slack', null);
      return jsonResponse({ ok: true, imported: 0, note: 'no channels opted in' });
    }

    // Incremental: only messages after last sync (defaults to 24h back on first run)
    const since = conn?.last_sync_at
      ? new Date(conn.last_sync_at).getTime() / 1000
      : Date.now() / 1000 - 86400;

    let imported = 0;
    for (const channelId of channels.slice(0, 10)) {
      const history = await fetchSlack<{ messages?: SlackMessage[] }>(
        tokens.access_token,
        'conversations.history',
        {
          channel: channelId,
          oldest: String(since),
          limit: '30',
        },
      );
      const messages = history?.messages ?? [];

      for (const m of messages) {
        if (m.subtype) continue; // skip joins/leaves/system messages
        if (!m.text || m.text.length < 20) continue;

        const fingerprint = await sha256Hex(`slack|${channelId}|${m.ts}`);
        const content = `[Slack @ ${channelId}]\n${m.text}`;
        const { data: inserted } = await service
          .from('context_nodes')
          .upsert(
            {
              user_id,
              source: 'connector:slack',
              source_url: m.permalink ?? null,
              source_app: 'slack',
              content,
              tags: ['slack', 'message'],
              acl_agents: ['*'],
              fingerprint,
              metadata: { channel: channelId, ts: m.ts, thread_ts: m.thread_ts },
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
    }
    await updateSyncState(service, user_id, 'slack', null);
    return jsonResponse({ ok: true, imported, channels: channels.length });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('slack-sync error', e);
    return errorResponse('internal_error', 500);
  }
});
