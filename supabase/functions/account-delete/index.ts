/**
 * DELETE /functions/v1/account-delete
 * Schedules account deletion (RGPD Article 17 — right to be forgotten).
 *
 * Soft-deletes user immediately (loses access) and enqueues hard-delete
 * for 72h later via pgmq queue 'account_wipe'.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';
import { sendAccountDeletionScheduled } from '../_shared/email.ts';

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'DELETE' && req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    const { userId, client } = await requireUser(req);
    const { error } = await client.rpc('request_account_deletion', { p_user_id: userId });
    if (error) return errorResponse('delete_failed', 500, error);

    const hardDeleteAt = new Date(Date.now() + 72 * 3600_000).toISOString();

    // Notify the user (fire-and-forget)
    const { data: profile } = await client
      .from('users')
      .select('email')
      .eq('id', userId)
      .maybeSingle();
    if (profile?.email) {
      sendAccountDeletionScheduled(profile.email, hardDeleteAt).catch((e) =>
        console.warn('deletion email failed', e),
      );
    }

    return jsonResponse({
      ok: true,
      message: 'Your account is scheduled for deletion in 72 hours. You can still log in to cancel.',
      hard_delete_at: hardDeleteAt,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('account-delete error', e);
    return errorResponse('internal_error', 500);
  }
});
