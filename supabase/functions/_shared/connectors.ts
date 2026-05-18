/**
 * Connector infrastructure: token encryption helpers + base sync types.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

export type ConnectorProvider =
  | 'gmail'
  | 'gcal'
  | 'slack'
  | 'notion'
  | 'linear'
  | 'github'
  | 'figma'
  | 'gdocs';

export interface OAuthTokens {
  access_token: string;
  refresh_token: string | null;
  expires_at: number; // epoch ms
  scopes: string[];
}

export interface NodeInput {
  content: string;
  source: string;
  source_url?: string | null;
  source_app?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  fingerprint: string;
}

export async function storeTokens(
  client: SupabaseClient,
  userId: string,
  provider: ConnectorProvider,
  tokens: OAuthTokens,
  syncSettings: Record<string, unknown> = {},
): Promise<void> {
  // Encrypt access + refresh tokens via the public.encrypt_token() SQL helper.
  const { data: encAccess, error: e1 } = await client.rpc('encrypt_token', {
    p_token: tokens.access_token,
  });
  if (e1) throw new Error(`encrypt_access: ${e1.message}`);
  let encRefresh: string | null = null;
  if (tokens.refresh_token) {
    const { data, error } = await client.rpc('encrypt_token', { p_token: tokens.refresh_token });
    if (error) throw new Error(`encrypt_refresh: ${error.message}`);
    encRefresh = data as string;
  }

  await client.from('connectors').upsert(
    {
      user_id: userId,
      provider,
      status: 'active',
      oauth_access_token: encAccess as string,
      oauth_refresh_token: encRefresh,
      oauth_expires_at: new Date(tokens.expires_at).toISOString(),
      scopes: tokens.scopes,
      sync_settings: syncSettings,
    },
    { onConflict: 'user_id,provider' },
  );
}

export async function loadTokens(
  client: SupabaseClient,
  userId: string,
  provider: ConnectorProvider,
): Promise<OAuthTokens | null> {
  const { data, error } = await client
    .from('connectors')
    .select('oauth_access_token, oauth_refresh_token, oauth_expires_at, scopes')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error || !data) return null;

  const { data: access, error: ea } = await client.rpc('decrypt_token', {
    p_encrypted: data.oauth_access_token,
  });
  if (ea) return null;
  let refresh: string | null = null;
  if (data.oauth_refresh_token) {
    const { data: r } = await client.rpc('decrypt_token', { p_encrypted: data.oauth_refresh_token });
    refresh = (r as string) ?? null;
  }
  return {
    access_token: access as string,
    refresh_token: refresh,
    expires_at: data.oauth_expires_at ? new Date(data.oauth_expires_at).getTime() : 0,
    scopes: data.scopes ?? [],
  };
}

export async function updateSyncState(
  client: SupabaseClient,
  userId: string,
  provider: ConnectorProvider,
  cursor: string | null,
  status: 'active' | 'error' = 'active',
  errorMessage: string | null = null,
): Promise<void> {
  await client
    .from('connectors')
    .update({
      last_sync_at: new Date().toISOString(),
      last_sync_cursor: cursor,
      status,
      error_message: errorMessage,
    })
    .eq('user_id', userId)
    .eq('provider', provider);
}
