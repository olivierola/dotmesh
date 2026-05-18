/**
 * Slack OAuth (v2). Scopes default to user-token reading public channels the user is in.
 * DMs are NEVER requested by default. User can opt-in later.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';
import { storeTokens } from '../_shared/connectors.ts';

const USER_SCOPES = ['channels:read', 'channels:history', 'users:read'].join(',');

function redirect(): string {
  return (
    Deno.env.get('SLACK_REDIRECT_URI') ??
    `${Deno.env.get('SUPABASE_URL')}/functions/v1/connectors-slack-auth?action=callback`
  );
}

function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: Deno.env.get('SLACK_CLIENT_ID') ?? '',
    user_scope: USER_SCOPES,
    redirect_uri: redirect(),
    state,
  });
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  authed_user: {
    id: string;
    access_token: string;
    token_type: string;
    scope: string;
  };
  team?: { id: string; name: string };
}

async function exchangeCode(code: string): Promise<SlackOAuthResponse | null> {
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('SLACK_CLIENT_ID') ?? '',
      client_secret: Deno.env.get('SLACK_CLIENT_SECRET') ?? '',
      code,
      redirect_uri: redirect(),
    }),
  });
  const data = (await res.json()) as SlackOAuthResponse;
  if (!data.ok) return null;
  return data;
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

      const oauth = await exchangeCode(code);
      if (!oauth) return errorResponse('exchange_failed', 502);

      const service = createServiceClient();
      // Slack user tokens don't expire by default (no refresh token).
      await storeTokens(
        service,
        state.uid,
        'slack',
        {
          access_token: oauth.authed_user.access_token,
          refresh_token: null,
          expires_at: Date.now() + 10 * 365 * 86400_000, // ~never
          scopes: oauth.authed_user.scope.split(','),
        },
        {
          slack_user_id: oauth.authed_user.id,
          team: oauth.team,
          channels: [], // user must opt-in per channel
          exclude_dms: true,
        },
      );

      const webUrl = Deno.env.get('PUBLIC_WEB_URL') ?? 'http://localhost:5173';
      return new Response(null, {
        status: 302,
        headers: { Location: `${webUrl}/connectors?connected=slack` },
      });
    }
    return errorResponse('unknown_action', 400);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('slack-auth error', e);
    return errorResponse('internal_error', 500);
  }
});
