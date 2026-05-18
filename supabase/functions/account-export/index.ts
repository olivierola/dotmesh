/**
 * GET /functions/v1/account-export
 * Returns the user's full dataset as JSON (RGPD Article 20 — portability).
 * Calls the public.export_user_data() SQL function under the user JWT.
 */

import { handleCorsPreflight, corsHeaders } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { errorResponse } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'GET') return errorResponse('method_not_allowed', 405);

  try {
    const { userId, client } = await requireUser(req);

    const { data, error } = await client.rpc('export_user_data', { p_user_id: userId });
    if (error) return errorResponse('export_failed', 500, error);

    // Audit (fire-and-forget)
    const service = createServiceClient();
    service
      .from('audit_log')
      .insert({ user_id: userId, operation: 'account.export' })
      .then(() => {})
      .catch((e: unknown) => console.warn('audit insert failed', e));

    const filename = `mesh-export-${new Date().toISOString().split('T')[0]}.json`;
    return new Response(JSON.stringify(data, null, 2), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('account-export error', e);
    return errorResponse('internal_error', 500);
  }
});
