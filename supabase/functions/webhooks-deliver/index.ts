/**
 * POST /functions/v1/webhooks-deliver
 *
 * Cron-invoked worker that picks pending/retrying deliveries, signs them with
 * the webhook's secret (HMAC-SHA256 over body, like Stripe), and POSTs.
 *
 * Retry policy: exponential backoff 1m → 5m → 30m → 2h → 12h. After 5 failures
 * the delivery is marked 'dead' and the webhook's failure_count is incremented.
 * After 20 consecutive failures the webhook is auto-disabled.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';

const BATCH = 25;
const BACKOFFS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000];
const MAX_ATTEMPTS = 5;
const DISABLE_AT_FAILURES = 20;

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  user_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  webhook: { url: string; secret: string; active: boolean; failure_count: number };
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`) {
    return errorResponse('forbidden', 403);
  }

  const service = createServiceClient();

  // Atomically claim a batch — bump status to 'retrying' so concurrent workers don't pick the same rows.
  const { data: claimed, error: claimErr } = await service
    .from('webhook_deliveries')
    .select(
      `id, webhook_id, user_id, event_type, payload, attempts,
       webhook:webhooks!inner(url, secret, active, failure_count)`,
    )
    .in('status', ['pending', 'retrying'])
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(BATCH);

  if (claimErr) return errorResponse('claim_failed', 500, claimErr);

  let delivered = 0;
  let failed = 0;
  for (const row of (claimed ?? []) as unknown as DeliveryRow[]) {
    if (!row.webhook.active) {
      await service
        .from('webhook_deliveries')
        .update({ status: 'dead', last_response_body: 'webhook_inactive' })
        .eq('id', row.id);
      continue;
    }

    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify(row.payload);
    const signedBody = `${ts}.${body}`;
    const sig = await hmacSha256Hex(row.webhook.secret, signedBody);
    const headerSig = `t=${ts},v1=${sig}`;

    let status = 0;
    let bodySnippet = '';
    try {
      const res = await fetch(row.webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mesh-Webhooks/1.0',
          'Mesh-Event': row.event_type,
          'Mesh-Delivery': row.id,
          'Mesh-Signature': headerSig,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      status = res.status;
      bodySnippet = (await res.text().catch(() => '')).slice(0, 500);
    } catch (e) {
      bodySnippet = (e as Error).message.slice(0, 500);
    }

    const success = status >= 200 && status < 300;
    const attempts = row.attempts + 1;

    if (success) {
      delivered++;
      await service
        .from('webhook_deliveries')
        .update({
          status: 'success',
          attempts,
          last_response_code: status,
          last_response_body: bodySnippet,
          delivered_at: new Date().toISOString(),
        })
        .eq('id', row.id);

      await service
        .from('webhooks')
        .update({
          last_delivered_at: new Date().toISOString(),
          last_status: status,
          failure_count: 0,
        })
        .eq('id', row.webhook_id);
    } else {
      failed++;
      const isDead = attempts >= MAX_ATTEMPTS;
      const backoff = BACKOFFS_MS[Math.min(attempts - 1, BACKOFFS_MS.length - 1)] ?? 0;
      await service
        .from('webhook_deliveries')
        .update({
          status: isDead ? 'dead' : 'retrying',
          attempts,
          last_response_code: status || null,
          last_response_body: bodySnippet,
          next_attempt_at: isDead
            ? null
            : new Date(Date.now() + backoff).toISOString(),
        })
        .eq('id', row.id);

      const newFailureCount = row.webhook.failure_count + (isDead ? 1 : 0);
      const update: Record<string, unknown> = {
        last_status: status,
        failure_count: newFailureCount,
      };
      if (newFailureCount >= DISABLE_AT_FAILURES) update.active = false;
      await service.from('webhooks').update(update).eq('id', row.webhook_id);
    }
  }

  return jsonResponse({
    ok: true,
    processed: (claimed ?? []).length,
    delivered,
    failed,
  });
});
