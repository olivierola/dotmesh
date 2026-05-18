/**
 * POST /functions/v1/billing-checkout
 * body: { tier: 'personal' | 'pro', interval: 'month' | 'year' }
 *
 * Creates a Stripe Checkout Session for the authenticated user.
 * Returns { url } that the client redirects to.
 *
 * Stripe customer is created on the fly if missing and saved to public.users.
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';

const inputSchema = z.object({
  tier: z.enum(['personal', 'pro']),
  interval: z.enum(['month', 'year']).default('month'),
});

const STRIPE_API = 'https://api.stripe.com/v1';

async function stripeRequest<T = unknown>(
  path: string,
  body: Record<string, string> = {},
  method: 'POST' | 'GET' = 'POST',
): Promise<T> {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) throw new Error('STRIPE_SECRET_KEY missing');

  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };
  if (method === 'POST') {
    opts.body = new URLSearchParams(body).toString();
  }
  const res = await fetch(`${STRIPE_API}${path}`, opts);
  if (!res.ok) {
    throw new Error(`stripe_${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function priceIdFor(tier: 'personal' | 'pro', interval: 'month' | 'year'): string {
  const map: Record<string, string | undefined> = {
    personal_month: Deno.env.get('STRIPE_PRICE_PERSONAL_MONTH'),
    personal_year: Deno.env.get('STRIPE_PRICE_PERSONAL_YEAR'),
    pro_month: Deno.env.get('STRIPE_PRICE_PRO_MONTH'),
    pro_year: Deno.env.get('STRIPE_PRICE_PRO_YEAR'),
  };
  const id = map[`${tier}_${interval}`];
  if (!id) throw new Error(`missing_price_id:${tier}_${interval}`);
  return id;
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    const { userId, client } = await requireUser(req);
    const raw = await parseJsonBody<unknown>(req);
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());
    const input = parsed.data;

    // Load user (need email + existing stripe_customer_id)
    const { data: user, error: userErr } = await client
      .from('users')
      .select('email, stripe_customer_id')
      .eq('id', userId)
      .maybeSingle();
    if (userErr || !user) return errorResponse('user_not_found', 404);

    const service = createServiceClient();
    let customerId = user.stripe_customer_id;

    if (!customerId) {
      const customer = await stripeRequest<{ id: string }>('/customers', {
        email: user.email,
        'metadata[user_id]': userId,
      });
      customerId = customer.id;
      await service
        .from('users')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);
    }

    const webUrl = Deno.env.get('PUBLIC_WEB_URL') ?? 'http://localhost:5173';
    const session = await stripeRequest<{ id: string; url: string }>('/checkout/sessions', {
      mode: 'subscription',
      customer: customerId,
      'line_items[0][price]': priceIdFor(input.tier, input.interval),
      'line_items[0][quantity]': '1',
      success_url: `${webUrl}/settings?checkout=success`,
      cancel_url: `${webUrl}/settings?checkout=cancel`,
      'subscription_data[metadata][user_id]': userId,
      'subscription_data[metadata][tier]': input.tier,
      allow_promotion_codes: 'true',
      automatic_tax: 'true',
    });

    return jsonResponse({ url: session.url, session_id: session.id });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('billing-checkout error', e);
    return errorResponse('internal_error', 500, (e as Error).message);
  }
});
