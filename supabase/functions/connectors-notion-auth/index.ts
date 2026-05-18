/**
 * Notion OAuth (public integration).
 * Tokens are long-lived (no refresh). User grants access to selected pages/databases
 * via Notion's own picker — Notion enforces scope, not us.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';
import { storeTokens } from '../_shared/connectors.ts';

function redirect(): string {
  return (
    Deno.env.get('NOTION_REDIRECT_URI') ??
    `${Deno.env.get('SUPABASE_URL')}/functions/v1/connectors-notion-auth?action=callback`
  );
}

function authUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: Deno.env.get('NOTION_CLIENT_ID') ?? '',
    response_type: 'code',
    owner: 'user',
    redirect_uri: redirect(),
    state,
  });
  return `https://api.notion.com/v1/oauth/authorize?${params}`;
}

interface NotionToken {
  access_token: string;
  workspace_id: string;
  workspace_name: string | null;
  bot_id: string;
}

async function exchangeCode(code: string): Promise<NotionToken | null> {
  const clientId = Deno.env.get('NOTION_CLIENT_ID') ?? '';
  const secret = Deno.env.get('NOTION_CLIENT_SECRET') ?? '';
  const basic = btoa(`${clientId}:${secret}`);
  const res = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect(),
    }),
  });
  if (!res.ok) return null;
  return (await res.json()) as NotionToken;
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

      const tok = await exchangeCode(code);
      if (!tok) return errorResponse('exchange_failed', 502);

      const service = createServiceClient();
      await storeTokens(
        service,
        state.uid,
        'notion',
        {
          access_token: tok.access_token,
          refresh_token: null,
          expires_at: Date.now() + 10 * 365 * 86400_000,
          scopes: [],
        },
        { workspace_id: tok.workspace_id, workspace_name: tok.workspace_name, bot_id: tok.bot_id },
      );

      const webUrl = Deno.env.get('PUBLIC_WEB_URL') ?? 'http://localhost:5173';
      return new Response(null, {
        status: 302,
        headers: { Location: `${webUrl}/connectors?connected=notion` },
      });
    }
    return errorResponse('unknown_action', 400);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('notion-auth error', e);
    return errorResponse('internal_error', 500);
  }
});
