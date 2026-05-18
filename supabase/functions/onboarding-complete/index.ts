/**
 * POST /functions/v1/onboarding-complete
 * Marks the user's onboarding as complete.
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse } from '../_shared/http.ts';
import { sendWelcomeEmail } from '../_shared/email.ts';

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  try {
    const { userId, client } = await requireUser(req);
    const { data: user } = await client
      .from('users')
      .select('email, display_name, onboarding_completed_at')
      .eq('id', userId)
      .maybeSingle();

    const firstTime = !user?.onboarding_completed_at;

    const { error } = await client
      .from('users')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) return errorResponse('update_failed', 500, error);

    if (firstTime && user?.email) {
      sendWelcomeEmail(user.email, user.display_name ?? undefined).catch((e) =>
        console.warn('welcome email failed', e),
      );
    }
    return jsonResponse({ ok: true, welcome_sent: firstTime });
  } catch (e) {
    if (e instanceof Response) return e;
    return errorResponse('internal_error', 500);
  }
});
