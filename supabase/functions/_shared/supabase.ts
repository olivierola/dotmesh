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
