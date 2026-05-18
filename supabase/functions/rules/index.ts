/**
 * GET    /functions/v1/rules        list user rules
 * POST   /functions/v1/rules        create rule
 * PATCH  /functions/v1/rules/:id    update rule
 * DELETE /functions/v1/rules/:id    delete rule
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';

const ruleSchema = z.object({
  rule_type: z.enum(['agent_acl', 'tag_block', 'domain_block', 'time_window']),
  target: z.string().min(1).max(200),
  action: z.enum(['allow', 'deny', 'redact']),
  filter: z
    .object({
      tags: z.array(z.string()).optional(),
      sources: z.array(z.string()).optional(),
      since: z.string().optional(),
      until: z.string().optional(),
    })
    .default({}),
  priority: z.number().int().min(0).max(1000).default(100),
  enabled: z.boolean().default(true),
});

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  try {
    const { userId, client } = await requireUser(req);
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const id = segments[segments.length - 1];
    const hasId = id && id !== 'rules';

    if (req.method === 'GET' && !hasId) {
      const { data, error } = await client
        .from('context_rules')
        .select('*')
        .order('priority', { ascending: false });
      if (error) return errorResponse('list_failed', 500, error);
      return jsonResponse({ rules: data ?? [] });
    }

    if (req.method === 'POST') {
      const raw = await parseJsonBody<unknown>(req);
      const parsed = ruleSchema.safeParse(raw);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const { data, error } = await client
        .from('context_rules')
        .insert({ ...parsed.data, user_id: userId })
        .select('*')
        .single();
      if (error) return errorResponse('insert_failed', 500, error);
      return jsonResponse({ rule: data }, 201);
    }

    if (req.method === 'PATCH' && hasId) {
      const raw = await parseJsonBody<unknown>(req);
      const parsed = ruleSchema.partial().safeParse(raw);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const { data, error } = await client
        .from('context_rules')
        .update(parsed.data)
        .eq('id', id)
        .select('*')
        .single();
      if (error) return errorResponse('update_failed', 500, error);
      return jsonResponse({ rule: data });
    }

    if (req.method === 'DELETE' && hasId) {
      const { error } = await client.from('context_rules').delete().eq('id', id);
      if (error) return errorResponse('delete_failed', 500, error);
      return jsonResponse({ ok: true });
    }

    return errorResponse('method_not_allowed', 405);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('rules error', e);
    return errorResponse('internal_error', 500);
  }
});
