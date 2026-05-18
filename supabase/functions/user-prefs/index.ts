/**
 * GET   /functions/v1/user-prefs   → load notification + UI prefs
 * PATCH /functions/v1/user-prefs   → partial update
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';

const patchSchema = z.object({
  notification_prefs: z
    .object({
      weekly_digest_email: z.boolean().optional(),
      realtime_in_app: z.boolean().optional(),
      product_updates: z.boolean().optional(),
      security_alerts: z.boolean().optional(),
    })
    .optional(),
  ui_prefs: z
    .object({
      theme: z.enum(['dark', 'light', 'system']).optional(),
      compact_density: z.boolean().optional(),
      injection_auto_accept_ms: z.number().int().min(0).max(10000).optional(),
    })
    .optional(),
});

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  try {
    const { userId, client } = await requireUser(req);

    if (req.method === 'GET') {
      const { data, error } = await client
        .from('users')
        .select('notification_prefs, ui_prefs')
        .eq('id', userId)
        .maybeSingle();
      if (error) return errorResponse('load_failed', 500, error);
      return jsonResponse({
        notification_prefs: data?.notification_prefs ?? {},
        ui_prefs: data?.ui_prefs ?? {},
      });
    }

    if (req.method === 'PATCH') {
      const raw = await parseJsonBody<unknown>(req);
      const parsed = patchSchema.safeParse(raw);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      // Merge instead of replace
      const { data: existing } = await client
        .from('users')
        .select('notification_prefs, ui_prefs')
        .eq('id', userId)
        .maybeSingle();

      const merged: Record<string, unknown> = {};
      if (parsed.data.notification_prefs) {
        merged.notification_prefs = {
          ...(existing?.notification_prefs ?? {}),
          ...parsed.data.notification_prefs,
        };
      }
      if (parsed.data.ui_prefs) {
        merged.ui_prefs = {
          ...(existing?.ui_prefs ?? {}),
          ...parsed.data.ui_prefs,
        };
      }

      const { data, error } = await client
        .from('users')
        .update(merged)
        .eq('id', userId)
        .select('notification_prefs, ui_prefs')
        .single();
      if (error) return errorResponse('update_failed', 500, error);
      return jsonResponse(data);
    }

    return errorResponse('method_not_allowed', 405);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('user-prefs error', e);
    return errorResponse('internal_error', 500);
  }
});
