/**
 * GET  /functions/v1/connectors-gmail-auth?action=start  → redirect to Google consent
 * GET  /functions/v1/connectors-gmail-auth?action=callback&code=... → exchange + store
 *
 * State param contains the user JWT (signed pass-through) — we re-verify on callback.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';
import { storeTokens } from '../_shared/connectors.ts';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function authUrl(state: string): string {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
  const redirectUri =
    Deno.env.get('GOOGLE_REDIRECT_URI') ??
    `${Deno.env.get('SUPABASE_URL')}/functions/v1/connectors-gmail-auth?action=callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES.join(' '),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(code: string): Promise<{
  access_token: string;
  refresh_token: string | null;
  expires_in: number;
  scope: string;
} | null> {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID') ?? '';
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '';
  const redirectUri =
    Deno.env.get('GOOGLE_REDIRECT_URI') ??
    `${Deno.env.get('SUPABASE_URL')}/functions/v1/connectors-gmail-auth?action=callback`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    console.error('Token exchange failed', res.status, await res.text());
    return null;
  }
  return (await res.json()) as {
    access_token: string;
    refresh_token: string | null;
    expires_in: number;
    scope: string;
  };
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  try {
    if (action === 'start') {
      const { userId } = await requireUser(req);
      // Use the JWT itself as state — opaque to Google, we'll re-verify on callback.
      const auth = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
      const state = btoa(JSON.stringify({ uid: userId, jwt: auth.slice(0, 800) }));
      return jsonResponse({ auth_url: authUrl(state) });
    }

    if (action === 'callback') {
      const code = url.searchParams.get('code');
      const stateRaw = url.searchParams.get('state');
      if (!code || !stateRaw) return errorResponse('missing_params', 400);

      let state: { uid: string; jwt: string };
      try {
        state = JSON.parse(atob(stateRaw));
      } catch {
        return errorResponse('invalid_state', 400);
      }

      // Verify the JWT corresponds to the same user
      const verifyClient = (await import('@supabase/supabase-js')).createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: `Bearer ${state.jwt}` } } },
      );
      const { data: u } = await verifyClient.auth.getUser();
      if (!u?.user || u.user.id !== state.uid) {
        return errorResponse('state_mismatch', 401);
      }

      const tokens = await exchangeCode(code);
      if (!tokens) return errorResponse('exchange_failed', 502);

      const service = createServiceClient();
      await storeTokens(service, state.uid, 'gmail', {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        scopes: tokens.scope.split(' '),
      });

      // Redirect to dashboard
      const webUrl = Deno.env.get('PUBLIC_WEB_URL') ?? 'http://localhost:5173';
      return new Response(null, {
        status: 302,
        headers: { Location: `${webUrl}/connectors?connected=gmail` },
      });
    }

    return errorResponse('unknown_action', 400);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('gmail-auth error', e);
    return errorResponse('internal_error', 500);
  }
});
