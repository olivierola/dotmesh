/**
 * Webhooks CRUD endpoint.
 * GET    /functions/v1/webhooks         list (without secret)
 * POST   /functions/v1/webhooks         create — returns secret ONCE
 * PATCH  /functions/v1/webhooks/:id     update events / url / active
 * DELETE /functions/v1/webhooks/:id     remove
 * POST   /functions/v1/webhooks/:id/test  send a ping delivery
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';

const ALLOWED_EVENTS = ['*', 'node.created', 'node.deleted', 'injection'] as const;

const createSchema = z.object({
  url: z.string().url().startsWith('https://').max(500),
  events: z.array(z.enum(ALLOWED_EVENTS)).min(1).default(['*']),
  description: z.string().max(200).optional(),
});

const patchSchema = z.object({
  url: z.string().url().startsWith('https://').max(500).optional(),
  events: z.array(z.enum(ALLOWED_EVENTS)).min(1).optional(),
  description: z.string().max(200).optional(),
  active: z.boolean().optional(),
});

function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return (
    'whsec_' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  try {
    const { userId, client } = await requireUser(req);
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    const beforeLast = segments[segments.length - 2];

    // /webhooks/:id/test
    if (req.method === 'POST' && last === 'test' && beforeLast && beforeLast !== 'webhooks') {
      const service = createServiceClient();
      const { data: hook } = await client
        .from('webhooks_public')
        .select('id, url, events')
        .eq('id', beforeLast)
        .maybeSingle();
      if (!hook) return errorResponse('webhook_not_found', 404);

      const { error } = await service.from('webhook_deliveries').insert({
        webhook_id: hook.id,
        user_id: userId,
        event_type: 'ping',
        payload: { event: 'ping', sent_at: new Date().toISOString() },
        next_attempt_at: new Date().toISOString(),
      });
      if (error) return errorResponse('enqueue_failed', 500, error);
      return jsonResponse({ ok: true, message: 'Test delivery enqueued.' });
    }

    const id = last && last !== 'webhooks' ? last : null;

    if (req.method === 'GET' && !id) {
      const { data, error } = await client
        .from('webhooks_public')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) return errorResponse('list_failed', 500, error);
      return jsonResponse({ webhooks: data ?? [] });
    }

    if (req.method === 'POST' && !id) {
      const raw = await parseJsonBody<unknown>(req);
      const parsed = createSchema.safeParse(raw);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const secret = generateSecret();
      const service = createServiceClient();
      const { data, error } = await service
        .from('webhooks')
        .insert({
          user_id: userId,
          url: parsed.data.url,
          events: parsed.data.events,
          description: parsed.data.description ?? null,
          secret,
        })
        .select('id, url, events, description, active, created_at')
        .single();
      if (error) return errorResponse('insert_failed', 500, error);
      // Secret returned ONCE; never readable afterwards.
      return jsonResponse({ webhook: data, secret }, 201);
    }

    if (req.method === 'PATCH' && id) {
      const raw = await parseJsonBody<unknown>(req);
      const parsed = patchSchema.safeParse(raw);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());
      const { data, error } = await client
        .from('webhooks')
        .update(parsed.data)
        .eq('id', id)
        .select('id, url, events, description, active, created_at, updated_at')
        .single();
      if (error) return errorResponse('update_failed', 500, error);
      return jsonResponse({ webhook: data });
    }

    if (req.method === 'DELETE' && id) {
      const { error } = await client.from('webhooks').delete().eq('id', id);
      if (error) return errorResponse('delete_failed', 500, error);
      return jsonResponse({ ok: true });
    }

    return errorResponse('method_not_allowed', 405);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('webhooks error', e);
    return errorResponse('internal_error', 500);
  }
});
