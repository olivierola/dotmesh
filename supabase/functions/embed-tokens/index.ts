/**
 * GET    /functions/v1/embed-tokens         list
 * POST   /functions/v1/embed-tokens         create — returns plaintext ONCE
 * PATCH  /functions/v1/embed-tokens/:id     update origins / scopes / active
 * DELETE /functions/v1/embed-tokens/:id     remove
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';

const createSchema = z.object({
  name: z.string().min(1).max(80),
  allowed_origins: z.array(z.string().min(1).max(200)).min(1).max(20),
  rate_limit_per_minute: z.number().int().min(1).max(600).default(20),
  collection_ids: z.array(z.string().uuid()).max(20).default([]),
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  allowed_origins: z.array(z.string()).min(1).max(20).optional(),
  rate_limit_per_minute: z.number().int().min(1).max(600).optional(),
  active: z.boolean().optional(),
  collection_ids: z.array(z.string().uuid()).max(20).optional(),
});

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function newPlainToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return (
    'mesh_embed_' +
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
    const id = last && last !== 'embed-tokens' ? last : null;

    if (req.method === 'GET' && !id) {
      const { data, error } = await client
        .from('embed_tokens')
        .select('id, name, token_prefix, allowed_origins, rate_limit_per_minute, scopes, collection_ids, active, last_used_at, call_count, created_at')
        .order('created_at', { ascending: false });
      if (error) return errorResponse('list_failed', 500, error);
      return jsonResponse({ tokens: data ?? [] });
    }

    if (req.method === 'POST' && !id) {
      const raw = await parseJsonBody<unknown>(req);
      const parsed = createSchema.safeParse(raw);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const plain = newPlainToken();
      const hash = await sha256Hex(plain);
      const prefix = plain.slice(0, 18) + '…'; // mesh_embed_xxxxxxx…

      const service = createServiceClient();
      const { data, error } = await service
        .from('embed_tokens')
        .insert({
          user_id: userId,
          token_hash: hash,
          token_prefix: prefix,
          name: parsed.data.name,
          allowed_origins: parsed.data.allowed_origins,
          rate_limit_per_minute: parsed.data.rate_limit_per_minute,
          collection_ids: parsed.data.collection_ids,
        })
        .select(
          'id, name, token_prefix, allowed_origins, rate_limit_per_minute, scopes, active, created_at',
        )
        .single();
      if (error) return errorResponse('insert_failed', 500, error);
      return jsonResponse({ token: data, plaintext: plain }, 201);
    }

    if (req.method === 'PATCH' && id) {
      const raw = await parseJsonBody<unknown>(req);
      const parsed = patchSchema.safeParse(raw);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());
      const { data, error } = await client
        .from('embed_tokens')
        .update(parsed.data)
        .eq('id', id)
        .select('*')
        .single();
      if (error) return errorResponse('update_failed', 500, error);
      return jsonResponse({ token: data });
    }

    if (req.method === 'DELETE' && id) {
      const { error } = await client.from('embed_tokens').delete().eq('id', id);
      if (error) return errorResponse('delete_failed', 500, error);
      return jsonResponse({ ok: true });
    }

    return errorResponse('method_not_allowed', 405);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('embed-tokens error', e);
    return errorResponse('internal_error', 500);
  }
});
