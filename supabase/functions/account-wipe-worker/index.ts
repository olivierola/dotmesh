/**
 * POST /functions/v1/account-wipe-worker
 *
 * Cron-invoked worker that hard-deletes accounts whose 72h grace period passed.
 * Authenticated via service role.
 *
 * Strategy: scan users with deleted_at < now() - 72h and call execute_account_wipe().
 * Avoids needing pgmq for this volume.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`) {
    return errorResponse('forbidden', 403);
  }

  try {
    const service = createServiceClient();
    const threshold = new Date(Date.now() - 72 * 3600_000).toISOString();

    const { data: due, error } = await service
      .from('users')
      .select('id')
      .not('deleted_at', 'is', null)
      .lt('deleted_at', threshold)
      .limit(50);

    if (error) return errorResponse('list_failed', 500, error);

    let wiped = 0;
    for (const row of due ?? []) {
      try {
        await service.rpc('execute_account_wipe', { p_user_id: row.id });
        wiped++;
      } catch (e) {
        console.warn('wipe failed for', row.id, e);
      }
    }

    return jsonResponse({ ok: true, wiped, candidates: due?.length ?? 0 });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('account-wipe-worker error', e);
    return errorResponse('internal_error', 500);
  }
});
