import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

/**
 * Create a Supabase client scoped to the calling user's JWT.
 * RLS applies based on auth.uid().
 */
export function createUserClient(req: Request): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';

  return createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Create a Supabase client with service role privileges.
 * Use ONLY for admin operations (audit_log writes, usage increments, RGPD wipes).
 */
export function createServiceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Decode a JWT payload (no signature verification). Used only to look up
 * the `role` claim — we do not trust the token for anything else.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Service-role auth guard for internal fire-and-forget calls between Edge
 * Functions.
 *
 * Accepts the request if EITHER:
 *   - the Authorization bearer matches one of the service-role secrets
 *     known to this function (legacy SUPABASE_SERVICE_ROLE_KEY, new
 *     publishable SUPABASE_SECRET_KEYS), OR
 *   - the bearer is a JWT whose `role` claim is `service_role`.
 *
 * The second branch keeps the guard working even when the caller and
 * callee read the env var in different forms (Supabase rotates / aliases
 * service-role keys; comparing strings verbatim is brittle).
 */
export function assertServiceRole(req: Request): void {
  const auth = req.headers.get('Authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!bearer) {
    throw new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const candidates = [
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
    Deno.env.get('SUPABASE_SECRET_KEY'),
    Deno.env.get('SUPABASE_SECRET_KEYS'),
  ].filter((v): v is string => !!v);
  if (candidates.includes(bearer)) return;

  const payload = decodeJwtPayload(bearer);
  if (payload && payload.role === 'service_role') return;

  throw new Response(JSON.stringify({ error: 'forbidden' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Resolve the authenticated user id from a request.
 * Throws 401 Response if missing or invalid.
 */
export async function requireUser(req: Request): Promise<{
  userId: string;
  client: SupabaseClient;
}> {
  const client = createUserClient(req);
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) {
    throw new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return { userId: data.user.id, client };
}
