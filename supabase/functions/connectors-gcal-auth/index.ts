/**
 * Google Calendar OAuth start + callback.
 * Same pattern as Gmail (state = base64 of {uid, jwt} re-verified server-side).
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';
import { storeTokens } from '../_shared/connectors.ts';

const SCOPES = ['https://www.googleapis.com/auth/calendar.events.readonly'];

function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
    redirect_uri:
      Deno.env.get('GOOGLE_GCAL_REDIRECT_URI') ??
      `${Deno.env.get('SUPABASE_URL')}/functions/v1/connectors-gcal-auth?action=callback`,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES.join(' '),
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
      redirect_uri:
        Deno.env.get('GOOGLE_GCAL_REDIRECT_URI') ??
        `${Deno.env.get('SUPABASE_URL')}/functions/v1/connectors-gcal-auth?action=callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) return null;
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
      const jwt = req.headers.get('Authorization')?.replace('Bearer ', '') ?? '';
      const state = btoa(JSON.stringify({ uid: userId, jwt: jwt.slice(0, 800) }));
      return jsonResponse({ auth_url: authUrl(state) });
    }

    if (action === 'callback') {
      const code = url.searchParams.get('code');
      const stateRaw = url.searchParams.get('state');
      if (!code || !stateRaw) return errorResponse('missing_params', 400);
      const state = JSON.parse(atob(stateRaw)) as { uid: string; jwt: string };

      const verifyClient = (await import('@supabase/supabase-js')).createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        { global: { headers: { Authorization: `Bearer ${state.jwt}` } } },
      );
      const { data: u } = await verifyClient.auth.getUser();
      if (!u?.user || u.user.id !== state.uid) return errorResponse('state_mismatch', 401);

      const tokens = await exchangeCode(code);
      if (!tokens) return errorResponse('exchange_failed', 502);

      const service = createServiceClient();
      await storeTokens(service, state.uid, 'gcal', {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + tokens.expires_in * 1000,
        scopes: tokens.scope.split(' '),
      });

      const webUrl = Deno.env.get('PUBLIC_WEB_URL') ?? 'http://localhost:5173';
      return new Response(null, {
        status: 302,
        headers: { Location: `${webUrl}/connectors?connected=gcal` },
      });
    }

    return errorResponse('unknown_action', 400);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('gcal-auth error', e);
    return errorResponse('internal_error', 500);
  }
});
