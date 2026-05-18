/**
 * POST /functions/v1/billing-portal
 * Creates a Stripe Customer Portal session for the authenticated user
 * to manage subscription, payment methods, invoices, cancellation.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    const { userId, client } = await requireUser(req);
    const { data: user, error } = await client
      .from('users')
      .select('stripe_customer_id')
      .eq('id', userId)
      .maybeSingle();
    if (error || !user?.stripe_customer_id) {
      return errorResponse('no_stripe_customer', 404);
    }

    const key = Deno.env.get('STRIPE_SECRET_KEY');
    if (!key) return errorResponse('stripe_not_configured', 500);

    const webUrl = Deno.env.get('PUBLIC_WEB_URL') ?? 'http://localhost:5173';
    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        customer: user.stripe_customer_id,
        return_url: `${webUrl}/settings`,
      }),
    });
    if (!res.ok) {
      return errorResponse('stripe_failed', 502, await res.text());
    }
    const session = (await res.json()) as { url: string };
    return jsonResponse({ url: session.url });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('billing-portal error', e);
    return errorResponse('internal_error', 500);
  }
});
