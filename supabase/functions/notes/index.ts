/**
 * Manual notes — backed by context_nodes (source='manual_note', node_type='note').
 *
 * GET    /functions/v1/notes               list user's notes
 * GET    /functions/v1/notes/:id           single note + linked-to / linked-from
 * POST   /functions/v1/notes               create
 * PATCH  /functions/v1/notes/:id           update title / content
 * DELETE /functions/v1/notes/:id           delete (cascades context_edges)
 *
 * Wiki-links: any `[[Other note title]]` inside the markdown content gets
 * resolved to its target note id and materialized as a context_edges row
 * with relation_type='note_link'. The graph page renders these differently.
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';

const createSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(100_000).default(''),
  html: z.string().max(200_000).optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(100_000).optional(),
  html: z.string().max(200_000).optional(),
});

/** Extract `[[wiki-link]]` targets from a raw markdown body. */
function extractWikiTargets(md: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]\n]{1,200})\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const t = m[1]!.trim();
    if (t) out.add(t);
  }
  return Array.from(out);
}

/**
 * Find existing notes (in this user's space) whose title matches one of the
 * given wiki-link targets (case-insensitive). Returns a map of normalized
 * title -> note id. Targets that don't resolve are simply ignored — the
 * frontend can decide whether to offer to create them.
 */
async function resolveWikiTargets(
  client: ReturnType<typeof createServiceClient>,
  userId: string,
  targets: string[],
): Promise<Map<string, string>> {
  if (targets.length === 0) return new Map();
  const lowered = targets.map((t) => t.toLowerCase());
  const { data } = await client
    .from('context_nodes')
    .select('id, summary, metadata')
    .eq('user_id', userId)
    .eq('source', 'manual_note');
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const title = ((row.metadata as Record<string, unknown> | null)?.note_title as
      | string
      | undefined) ?? (row.summary as string | null) ?? '';
    if (!title) continue;
    const norm = title.toLowerCase();
    if (lowered.includes(norm)) {
      map.set(norm, row.id as string);
    }
  }
  return map;
}

/**
 * Rebuilds the note_link edges for a given source note: drops all existing
 * outgoing note_link edges, then re-creates from the current wiki-link list.
 */
async function syncWikiLinks(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  sourceNoteId: string,
  body: string,
): Promise<{ created: number }> {
  const targets = extractWikiTargets(body);
  await service
    .from('context_edges')
    .delete()
    .eq('user_id', userId)
    .eq('from_node', sourceNoteId)
    .eq('relation_type', 'note_link');

  if (targets.length === 0) return { created: 0 };

  const resolved = await resolveWikiTargets(service, userId, targets);
  let created = 0;
  for (const [title, targetId] of resolved.entries()) {
    if (targetId === sourceNoteId) continue;
    const { error } = await service.from('context_edges').insert({
      user_id: userId,
      from_node: sourceNoteId,
      to_node: targetId,
      relation_type: 'note_link',
      confidence: 1.0,
      note: title,
    });
    if (!error) created++;
  }
  return { created };
}

function deriveSummary(content: string): string {
  // First non-empty line, max 200 chars.
  const line = content.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.replace(/^#+\s*/, '').slice(0, 200);
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  try {
    const { userId, client } = await requireUser(req);
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    const id = last && last !== 'notes' ? last : null;

    // ---------- list ----------
    if (req.method === 'GET' && !id) {
      const { data, error } = await client
        .from('context_nodes')
        .select('id, content, summary, metadata, tags, created_at, updated_at, pinned')
        .eq('source', 'manual_note')
        .order('updated_at', { ascending: false })
        .limit(200);
      if (error) return errorResponse('list_failed', 500, error);
      const notes = (data ?? []).map((n) => {
        const md = (n.metadata as Record<string, unknown> | null) ?? {};
        return {
          id: n.id,
          title: (md.note_title as string | undefined) ?? n.summary ?? '(untitled)',
          content: n.content ?? '',
          html: (md.note_html as string | undefined) ?? null,
          tags: n.tags ?? [],
          pinned: n.pinned ?? false,
          created_at: n.created_at,
          updated_at: n.updated_at,
        };
      });
      return jsonResponse({ notes });
    }

    // ---------- single ----------
    if (req.method === 'GET' && id) {
      const { data, error } = await client
        .from('context_nodes')
        .select('id, content, summary, metadata, tags, created_at, updated_at, pinned')
        .eq('id', id)
        .eq('source', 'manual_note')
        .maybeSingle();
      if (error || !data) return errorResponse('not_found', 404);

      // Linked-to (this note's outgoing wiki links) and linked-from (incoming).
      const [toRes, fromRes] = await Promise.all([
        client
          .from('context_edges')
          .select('to_node, note')
          .eq('from_node', id)
          .eq('relation_type', 'note_link'),
        client
          .from('context_edges')
          .select('from_node, note')
          .eq('to_node', id)
          .eq('relation_type', 'note_link'),
      ]);

      const md = (data.metadata as Record<string, unknown> | null) ?? {};
      return jsonResponse({
        note: {
          id: data.id,
          title: (md.note_title as string | undefined) ?? data.summary ?? '(untitled)',
          content: data.content ?? '',
          html: (md.note_html as string | undefined) ?? null,
          tags: data.tags ?? [],
          pinned: data.pinned ?? false,
          created_at: data.created_at,
          updated_at: data.updated_at,
        },
        links_out: (toRes.data ?? []).map((r) => ({
          id: r.to_node as string,
          title: (r.note as string | null) ?? '',
        })),
        links_in: (fromRes.data ?? []).map((r) => ({
          id: r.from_node as string,
          title: (r.note as string | null) ?? '',
        })),
      });
    }

    // ---------- create ----------
    if (req.method === 'POST' && !id) {
      const body = await parseJsonBody<unknown>(req);
      const parsed = createSchema.safeParse(body);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const service = createServiceClient();
      const summary = parsed.data.title.slice(0, 200);
      // content has a NOT-EMPTY CHECK constraint; use the title as content
      // when the body is empty so an Untitled note can still be created.
      const content =
        parsed.data.content && parsed.data.content.length > 0
          ? parsed.data.content
          : parsed.data.title;
      // fingerprint is NOT NULL; for manual notes we just derive a stable
      // random string — there's no dedup story for handwritten notes.
      const fingerprint = `note:${crypto.randomUUID()}`;

      const insertRes = await service
        .from('context_nodes')
        .insert({
          user_id: userId,
          source: 'manual_note',
          content,
          summary,
          tags: ['note'],
          score: 1.0,
          fingerprint,
          metadata: {
            note_title: parsed.data.title,
            note_html: parsed.data.html ?? null,
            // Hint the generated node_type column — 'note' isn't in its
            // whitelist so the column will resolve to NULL, but we keep
            // the hint here for our own filtering in the API.
            is_manual_note: true,
            extracted: { node_type: 'note', title: parsed.data.title },
          },
        })
        .select('id')
        .single();
      if (insertRes.error) return errorResponse('insert_failed', 500, insertRes.error);

      const noteId = insertRes.data.id as string;
      const { created } = await syncWikiLinks(service, userId, noteId, content);
      return jsonResponse({ note: { id: noteId }, wiki_links_created: created }, 201);
    }

    // ---------- patch ----------
    if (req.method === 'PATCH' && id) {
      const body = await parseJsonBody<unknown>(req);
      const parsed = patchSchema.safeParse(body);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const service = createServiceClient();
      // Pull existing metadata so we can merge instead of replace.
      const existing = await service
        .from('context_nodes')
        .select('metadata, content')
        .eq('id', id)
        .eq('user_id', userId)
        .eq('source', 'manual_note')
        .maybeSingle();
      if (!existing.data) return errorResponse('not_found', 404);

      const oldMd = (existing.data.metadata as Record<string, unknown> | null) ?? {};
      const newMd: Record<string, unknown> = { ...oldMd };
      if (parsed.data.title !== undefined) newMd.note_title = parsed.data.title;
      if (parsed.data.html !== undefined) newMd.note_html = parsed.data.html;

      const updates: Record<string, unknown> = {
        metadata: newMd,
        updated_at: new Date().toISOString(),
      };
      if (parsed.data.title !== undefined) updates.summary = parsed.data.title.slice(0, 200);
      if (parsed.data.content !== undefined) {
        // Respect the NOT-EMPTY CHECK: fall back to the (new or stored) title.
        const fallback =
          parsed.data.title ??
          ((oldMd.note_title as string | undefined) ?? '(untitled)');
        updates.content = parsed.data.content.length > 0 ? parsed.data.content : fallback;
      }

      const { error } = await service
        .from('context_nodes')
        .update(updates)
        .eq('id', id)
        .eq('user_id', userId);
      if (error) return errorResponse('update_failed', 500, error);

      // Re-sync wiki-links if the content changed.
      let wikiLinksCreated = 0;
      if (parsed.data.content !== undefined) {
        const r = await syncWikiLinks(service, userId, id, parsed.data.content);
        wikiLinksCreated = r.created;
      }
      return jsonResponse({ ok: true, wiki_links_created: wikiLinksCreated });
    }

    // ---------- delete ----------
    if (req.method === 'DELETE' && id) {
      const { error } = await client.from('context_nodes').delete().eq('id', id);
      if (error) return errorResponse('delete_failed', 500, error);
      return jsonResponse({ ok: true });
    }

    return errorResponse('method_not_allowed', 405);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('notes error', e);
    return errorResponse('internal_error', 500);
  }
});
