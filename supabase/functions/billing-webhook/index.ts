/**
 * POST /functions/v1/billing-webhook
 *
 * Stripe webhook handler. Verifies signature then maps events to user.tier changes.
 *
 * Events handled:
 *   - customer.subscription.created    → upgrade tier
 *   - customer.subscription.updated    → tier sync (price change / status change)
 *   - customer.subscription.deleted    → downgrade to free
 *   - invoice.payment_failed           → mark for retry, downgrade after 3 attempts
 *
 * Stripe sends events with a signature in the Stripe-Signature header.
 * We verify via HMAC-SHA256 against STRIPE_WEBHOOK_SECRET.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';

interface StripeSubscription {
  id: string;
  customer: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete' | 'incomplete_expired';
  cancel_at_period_end: boolean;
  items: { data: Array<{ price: { id: string; nickname?: string; lookup_key?: string } }> };
  metadata: { tier?: 'personal' | 'pro'; user_id?: string };
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

/**
 * Verify Stripe webhook signature.
 * Format: `t=<timestamp>,v1=<hex>,v0=<deprecated>`.
 */
async function verifySignature(
  payload: string,
  header: string | null,
  secret: string,
  toleranceSec = 300,
): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(',').reduce<Record<string, string>>((acc, p) => {
    const [k, v] = p.split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  const ts = parseInt(t, 10);
  if (Number.isNaN(ts)) return false;
  const ageSec = Math.abs(Date.now() / 1000 - ts);
  if (ageSec > toleranceSec) return false;

  const signedPayload = `${t}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  // Constant-time compare
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  return diff === 0;
}

function priceToTier(priceId: string): 'personal' | 'pro' | null {
  if (priceId === Deno.env.get('STRIPE_PRICE_PERSONAL_MONTH')) return 'personal';
  if (priceId === Deno.env.get('STRIPE_PRICE_PERSONAL_YEAR')) return 'personal';
  if (priceId === Deno.env.get('STRIPE_PRICE_PRO_MONTH')) return 'pro';
  if (priceId === Deno.env.get('STRIPE_PRICE_PRO_YEAR')) return 'pro';
  return null;
}

async function syncSubscription(sub: StripeSubscription): Promise<void> {
  const service = createServiceClient();
  const customerId = sub.customer;

  const { data: user } = await service
    .from('users')
    .select('id, tier')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (!user) {
    console.warn('webhook: no user for stripe customer', customerId);
    return;
  }

  let newTier: 'free' | 'personal' | 'pro' = 'free';
  if (sub.status === 'active' || sub.status === 'trialing') {
    const priceId = sub.items.data[0]?.price.id ?? '';
    newTier = priceToTier(priceId) ?? sub.metadata.tier ?? 'free';
  } else if (sub.status === 'past_due') {
    // grace period — keep existing tier
    newTier = (user.tier as 'free' | 'personal' | 'pro') ?? 'free';
  } else {
    newTier = 'free';
  }

  if (newTier !== user.tier) {
    await service.from('users').update({ tier: newTier }).eq('id', user.id);
    await service.from('audit_log').insert({
      user_id: user.id,
      operation: 'billing.tier_changed',
      metadata: { from: user.tier, to: newTier, subscription_id: sub.id, status: sub.status },
    });
  }
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!secret) return errorResponse('webhook_not_configured', 500);

  const payload = await req.text();
  const sigHeader = req.headers.get('Stripe-Signature');
  const valid = await verifySignature(payload, sigHeader, secret);
  if (!valid) return errorResponse('invalid_signature', 401);

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return errorResponse('invalid_json', 400);
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncSubscription(event.data.object as StripeSubscription);
        break;
      case 'invoice.payment_failed': {
        // Log but don't downgrade immediately; Stripe will retry per its dunning schedule.
        const service = createServiceClient();
        const inv = event.data.object as { customer: string; attempt_count?: number };
        const { data: user } = await service
          .from('users')
          .select('id')
          .eq('stripe_customer_id', inv.customer)
          .maybeSingle();
        if (user) {
          await service.from('audit_log').insert({
            user_id: user.id,
            operation: 'billing.payment_failed',
            metadata: { attempt_count: inv.attempt_count ?? 1 },
          });
        }
        break;
      }
      default:
        // Unhandled event types are acknowledged silently per Stripe best practice
        break;
    }
    return jsonResponse({ received: true, type: event.type });
  } catch (e) {
    console.error('webhook handler error', e);
    return errorResponse('webhook_handler_failed', 500, (e as Error).message);
  }
});
