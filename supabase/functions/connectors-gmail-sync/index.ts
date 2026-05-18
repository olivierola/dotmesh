/**
 * POST /functions/v1/connectors-gmail-sync
 * body: { user_id }     (service-role only — invoked by cron / orchestrator)
 *
 * Incremental sync of SENT emails using Gmail's history API.
 * - First run: scans last 30 days of SENT to seed cursor.
 * - Subsequent runs: uses history.list with startHistoryId for diff.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { loadTokens, updateSyncState, storeTokens } from '../_shared/connectors.ts';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

interface SyncInput {
  user_id: string;
}

async function refreshIfExpired(
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
  await storeTokens(service, userId, 'gmail', fresh);
  return fresh;
}

interface GmailMessage {
  id: string;
  threadId: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: Array<{ mimeType: string; body?: { data?: string }; parts?: GmailMessage['payload']['parts'] }>;
    body?: { data?: string };
    mimeType?: string;
  };
  internalDate?: string;
}

function decodeBase64Url(s: string): string {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(norm.padEnd(norm.length + ((4 - (norm.length % 4)) % 4), '=')), (c) => c.charCodeAt(0)),
    );
  } catch {
    return '';
  }
}

function extractPlainText(payload: GmailMessage['payload']): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) return decodeBase64Url(p.body.data);
    }
    // try nested
    for (const p of payload.parts) {
      const nested = extractPlainText(p as GmailMessage['payload']);
      if (nested) return nested;
    }
  }
  return '';
}

function headerValue(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function fetchMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessage | null> {
  const res = await fetch(`${GMAIL_API}/users/me/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as GmailMessage;
}

async function listSentMessageIds(
  accessToken: string,
  cursor: string | null,
): Promise<{ ids: string[]; nextCursor: string | null }> {
  if (cursor) {
    // History API for incremental sync.
    const params = new URLSearchParams({
      startHistoryId: cursor,
      historyTypes: 'messageAdded',
      labelId: 'SENT',
    });
    const res = await fetch(`${GMAIL_API}/users/me/history?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      // History expired (>30d) → fall back to message list
      return await initialList(accessToken);
    }
    const data = (await res.json()) as {
      history?: Array<{ messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }> }>;
      historyId?: string;
    };
    const ids = (data.history ?? [])
      .flatMap((h) => h.messagesAdded ?? [])
      .filter((m) => m.message.labelIds?.includes('SENT'))
      .map((m) => m.message.id);
    return { ids, nextCursor: data.historyId ?? cursor };
  }
  return await initialList(accessToken);
}

async function initialList(
  accessToken: string,
): Promise<{ ids: string[]; nextCursor: string | null }> {
  const params = new URLSearchParams({
    labelIds: 'SENT',
    maxResults: '50',
    q: 'newer_than:30d',
  });
  const res = await fetch(`${GMAIL_API}/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return { ids: [], nextCursor: null };
  const data = (await res.json()) as {
    messages?: Array<{ id: string }>;
    historyId?: string;
  };
  return { ids: (data.messages ?? []).map((m) => m.id), nextCursor: data.historyId ?? null };
}

async function pushNodeAsUser(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  payload: {
    content: string;
    source_url: string;
    fingerprint: string;
    metadata: Record<string, unknown>;
    tags: string[];
  },
): Promise<{ id: string } | null> {
  const { data, error } = await service
    .from('context_nodes')
    .upsert(
      {
        user_id: userId,
        source: 'connector:gmail',
        source_url: payload.source_url,
        source_app: 'gmail',
        content: payload.content,
        tags: payload.tags,
        acl_agents: ['*'],
        fingerprint: payload.fingerprint,
        metadata: payload.metadata,
      },
      { onConflict: 'user_id,fingerprint', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();
  if (error) {
    console.warn('gmail insert error', error);
    return null;
  }
  return data;
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  // Service-role only
  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`) {
    return errorResponse('forbidden', 403);
  }

  try {
    const { user_id } = await parseJsonBody<SyncInput>(req);
    if (!user_id) return errorResponse('user_id_required', 400);

    const service = createServiceClient();
    const tokens = await loadTokens(service, user_id, 'gmail');
    if (!tokens) return errorResponse('connector_not_found', 404);

    const fresh = await refreshIfExpired(service, user_id, tokens);

    // Get current cursor
    const { data: conn } = await service
      .from('connectors')
      .select('last_sync_cursor')
      .eq('user_id', user_id)
      .eq('provider', 'gmail')
      .maybeSingle();
    const cursor = conn?.last_sync_cursor ?? null;

    const { ids, nextCursor } = await listSentMessageIds(fresh.access_token, cursor);

    let imported = 0;
    for (const id of ids.slice(0, 50)) {
      const msg = await fetchMessage(fresh.access_token, id);
      if (!msg) continue;
      const subject = headerValue(msg, 'Subject');
      const to = headerValue(msg, 'To');
      const body = extractPlainText(msg.payload).slice(0, 4000);
      if (!body || body.length < 30) continue;

      const fingerprint = await sha256Hex(`gmail|${msg.id}`);
      const result = await pushNodeAsUser(service, user_id, {
        content: `[Email sent] To: ${to}\nSubject: ${subject}\n\n${body}`,
        source_url: `https://mail.google.com/mail/u/0/#sent/${msg.id}`,
        fingerprint,
        metadata: { gmail_message_id: msg.id, subject, to },
        tags: ['email', 'sent'],
      });
      if (result?.id) {
        imported++;
        // Trigger async processor
        fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/process-node`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ node_id: result.id }),
        }).catch(() => {});
      }
    }

    await updateSyncState(service, user_id, 'gmail', nextCursor);

    return jsonResponse({ ok: true, imported, next_cursor: nextCursor });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('gmail-sync error', e);
    return errorResponse('internal_error', 500);
  }
});
