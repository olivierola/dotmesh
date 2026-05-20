/**
 * Custom instructions CRUD.
 *
 * GET    /functions/v1/instructions       → list (with stats)
 * POST   /functions/v1/instructions       → create
 * PATCH  /functions/v1/instructions/:id   → update
 * DELETE /functions/v1/instructions/:id   → delete
 *
 * Each create/update kicks off a Jina embedding so the row becomes
 * available to the semantic matcher used by /inject.
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { jinaEmbed } from '../_shared/ai.ts';

const createSchema = z.object({
  title: z.string().min(1).max(120),
  context: z.string().max(2000).optional().nullable(),
  instruction: z.string().min(1).max(4000),
  icon: z.string().max(8).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  enabled: z.boolean().optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  context: z.string().max(2000).optional().nullable(),
  instruction: z.string().min(1).max(4000).optional(),
  icon: z.string().max(8).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

function embeddingInput(row: { title: string; context?: string | null; instruction: string }): string {
  return [row.title, row.context ?? '', row.instruction].filter(Boolean).join('\n\n');
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  try {
    const { userId, client } = await requireUser(req);
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    const id = last && last !== 'instructions' ? last : null;

    if (req.method === 'GET' && !id) {
      const { data, error } = await client
        .from('instructions')
        .select('id, title, context, instruction, enabled, icon, color, sort_order, created_at, updated_at, embedding')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) return errorResponse('list_failed', 500, error);
      // Don't leak the full embedding vector to the client — only signal
      // whether it's ready so the UI can show a "indexing…" state.
      const out = (data ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        context: r.context,
        instruction: r.instruction,
        enabled: r.enabled,
        icon: r.icon,
        color: r.color,
        sort_order: r.sort_order,
        created_at: r.created_at,
        updated_at: r.updated_at,
        indexed: !!r.embedding,
      }));
      return jsonResponse({ instructions: out });
    }

    if (req.method === 'POST' && !id) {
      const body = await parseJsonBody<unknown>(req);
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());
      const input = parsed.data;

      const { data, error } = await client
        .from('instructions')
        .insert({
          user_id: userId,
          title: input.title,
          context: input.context ?? null,
          instruction: input.instruction,
          icon: input.icon ?? null,
          color: input.color ?? null,
          enabled: input.enabled ?? true,
        })
        .select('*')
        .single();
      if (error || !data) return errorResponse('insert_failed', 500, error);

      // Fire-and-forget embedding via service role (works even when the
      // Jina call is slow — UI shows "indexed" once it lands).
      const service = createServiceClient();
      jinaEmbed(embeddingInput(input))
        .then((vec) => {
          if (vec) {
            return service
              .from('instructions')
              .update({ embedding: vec })
              .eq('id', data.id);
          }
        })
        .catch((e) => console.warn('embed instruction failed', e));

      return jsonResponse({ instruction: data }, 201);
    }

    if (req.method === 'PATCH' && id) {
      const body = await parseJsonBody<unknown>(req);
      const parsed = patchSchema.safeParse(body);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const { data, error } = await client
        .from('instructions')
        .update(parsed.data)
        .eq('id', id)
        .select('*')
        .single();
      if (error || !data) return errorResponse('update_failed', 500, error);

      // Re-embed if any text field changed.
      if (parsed.data.title || parsed.data.context !== undefined || parsed.data.instruction) {
        const service = createServiceClient();
        jinaEmbed(embeddingInput({
          title: data.title,
          context: data.context,
          instruction: data.instruction,
        }))
          .then((vec) => {
            if (vec) {
              return service
                .from('instructions')
                .update({ embedding: vec })
                .eq('id', id);
            }
          })
          .catch((e) => console.warn('re-embed instruction failed', e));
      }

      return jsonResponse({ instruction: data });
    }

    if (req.method === 'DELETE' && id) {
      const { error } = await client.from('instructions').delete().eq('id', id);
      if (error) return errorResponse('delete_failed', 500, error);
      return jsonResponse({ ok: true });
    }

    return errorResponse('method_not_allowed', 405);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('instructions error', e);
    return errorResponse('internal_error', 500);
  }
});
