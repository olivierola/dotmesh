/**
 * GET    /functions/v1/chat-sessions             list sessions
 * GET    /functions/v1/chat-sessions/:id         load session + all messages
 * PATCH  /functions/v1/chat-sessions/:id         rename / pin
 * DELETE /functions/v1/chat-sessions/:id         delete (cascades to messages)
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';

const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
});

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  try {
    const { client } = await requireUser(req);
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const id = segments[segments.length - 1];
    const hasId = id && id !== 'chat-sessions';

    if (req.method === 'GET' && !hasId) {
      const { data, error } = await client
        .from('chat_sessions')
        .select('id, title, pinned, created_at, updated_at')
        .order('updated_at', { ascending: false })
        .limit(100);
      if (error) return errorResponse('list_failed', 500, error);
      return jsonResponse({ sessions: data ?? [] });
    }

    if (req.method === 'GET' && hasId) {
      const [{ data: session, error: e1 }, { data: messages, error: e2 }] = await Promise.all([
        client.from('chat_sessions').select('*').eq('id', id).maybeSingle(),
        client
          .from('chat_messages')
          .select('id, role, content, cited_nodes, model, latency_ms, created_at')
          .eq('session_id', id)
          .order('created_at', { ascending: true }),
      ]);
      if (e1 || e2 || !session) return errorResponse('session_not_found', 404, e1 ?? e2);
      return jsonResponse({ session, messages: messages ?? [] });
    }

    if (req.method === 'PATCH' && hasId) {
      const body = await parseJsonBody<unknown>(req);
      const parsed = patchSchema.safeParse(body);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());
      const { data, error } = await client
        .from('chat_sessions')
        .update(parsed.data)
        .eq('id', id)
        .select('*')
        .single();
      if (error) return errorResponse('update_failed', 500, error);
      return jsonResponse({ session: data });
    }

    if (req.method === 'DELETE' && hasId) {
      const { error } = await client.from('chat_sessions').delete().eq('id', id);
      if (error) return errorResponse('delete_failed', 500, error);
      return jsonResponse({ ok: true });
    }

    return errorResponse('method_not_allowed', 405);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('chat-sessions error', e);
    return errorResponse('internal_error', 500);
  }
});
