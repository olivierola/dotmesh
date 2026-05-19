/**
 * LLM-driven collection assignment.
 *
 * Strategy:
 *   1. Run the deterministic filter classifier (collections-assigner.ts) first.
 *      Anything that matches a user-defined filter is assigned automatically.
 *   2. If nothing matched (or only the default Inbox matched), invoke a small
 *      LLM with the user's collection list + the node's extracted JSON, and
 *      ask it to (a) pick 0..N existing collections and (b) propose at most
 *      ONE new collection name when the node clearly doesn't fit any existing
 *      bucket and would form a coherent new theme.
 *
 * Why this layering: filter-based classification is cheap, deterministic, and
 * respects the user's explicit intent. The LLM is a safety net for nodes that
 * are obviously thematic but didn't match a literal filter.
 *
 * Cost guardrails:
 *   - Skip LLM if the user has >24 collections (signal: heavy curation, no
 *     need to invent more).
 *   - Skip LLM if the node has <60 chars of text (too sparse to reason about).
 *   - Cap suggested new collections per user per day (handled by usage table).
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { groqChat } from './ai.ts';
import type { Extracted } from './extracted.ts';

interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
}

interface AssignmentResult {
  /** Collection IDs the LLM picked (must already exist). */
  picked_ids: string[];
  /** Optional new collection name + description it wants to create. */
  new_collection: { name: string; description: string; icon?: string } | null;
}

const MAX_LLM_COLLECTIONS_PER_USER = 24;
const MIN_CONTENT_FOR_LLM = 60;

/**
 * Insert node_collections rows in bulk (idempotent on conflict).
 */
async function linkNodeToCollections(
  service: SupabaseClient,
  nodeId: string,
  userId: string,
  collectionIds: string[],
): Promise<number> {
  if (collectionIds.length === 0) return 0;
  const rows = collectionIds.map((cid) => ({
    node_id: nodeId,
    collection_id: cid,
    user_id: userId,
    source: 'auto' as const,
  }));
  const { error } = await service
    .from('node_collections')
    .upsert(rows, { onConflict: 'node_id,collection_id', ignoreDuplicates: true });
  if (error) {
    console.warn('link node_collections failed', error);
    return 0;
  }
  return rows.length;
}

/**
 * Ask the LLM which existing collections (if any) this node belongs to,
 * and whether a new collection should be created.
 */
async function askLLM(
  collections: CollectionRow[],
  extracted: Extracted,
  rawContent: string,
  tags: string[],
): Promise<AssignmentResult | null> {
  const list = collections
    .filter((c) => !c.is_default)
    .map((c, i) => `  ${i + 1}. id=${c.id} | "${c.name}" — ${c.description ?? '(no description)'}`)
    .join('\n');

  const snippet = [
    extracted.title && `Title: ${extracted.title}`,
    extracted.author && `Author: ${extracted.author}`,
    extracted.description && `Description: ${extracted.description}`,
    extracted.keywords.length > 0 && `Keywords: ${extracted.keywords.join(', ')}`,
    extracted.site_name && `Site: ${extracted.site_name}`,
    extracted.node_type && `Type: ${extracted.node_type}`,
    tags.length > 0 && `Tags: ${tags.join(', ')}`,
    extracted.content && `Content: ${extracted.content.slice(0, 1200)}`,
    !extracted.content && rawContent && `Content: ${rawContent.slice(0, 1200)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const sys =
    'You assign a captured memory to thematic collections. ' +
    'You return STRICT JSON only — no markdown, no prose.';

  const user = `User has these collections (excluding the default Inbox):
${list || '(none)'}

A new memory has just been captured:
${snippet}

Decide:
1. picked_ids: which existing collection IDs (zero or more) this memory clearly belongs to.
   Only pick a collection if the theme is an obvious match — not a stretch.
2. new_collection: propose AT MOST ONE new collection ONLY if:
     - the memory has a clear distinct theme,
     - no existing collection covers that theme,
     - the theme is broad enough that future memories would also fit it.
   If unsure, return null.

Return JSON:
{
  "picked_ids":     string[],
  "new_collection": null | { "name": string (max 40 chars), "description": string (max 200 chars), "icon": string (single emoji, optional) }
}`;

  const result = await groqChat({
    model: 'llama-3.1-8b-instant',
    systemPrompt: sys,
    userPrompt: user,
    jsonMode: true,
    maxTokens: 400,
    feature: 'collections-llm-assigner',
  });

  if (!result) return null;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    const knownIds = new Set(collections.map((c) => c.id));
    const picked_ids = Array.isArray(parsed.picked_ids)
      ? parsed.picked_ids.filter((x): x is string => typeof x === 'string' && knownIds.has(x))
      : [];
    let new_collection: AssignmentResult['new_collection'] = null;
    if (parsed.new_collection && typeof parsed.new_collection === 'object') {
      const nc = parsed.new_collection as Record<string, unknown>;
      if (
        typeof nc.name === 'string' &&
        nc.name.trim().length > 0 &&
        nc.name.trim().length <= 40 &&
        typeof nc.description === 'string'
      ) {
        new_collection = {
          name: nc.name.trim(),
          description: (nc.description as string).trim().slice(0, 200),
          icon: typeof nc.icon === 'string' ? nc.icon.trim().slice(0, 4) : undefined,
        };
      }
    }
    return { picked_ids, new_collection };
  } catch {
    return null;
  }
}

/**
 * Get-or-create a collection with the proposed name. Avoids creating a new
 * one if a case-insensitive name match already exists.
 */
async function getOrCreateCollection(
  service: SupabaseClient,
  userId: string,
  proposed: { name: string; description: string; icon?: string },
): Promise<string | null> {
  // Idempotency check (case-insensitive)
  const { data: existing } = await service
    .from('collections')
    .select('id, name')
    .eq('user_id', userId);
  const found = (existing ?? []).find(
    (c) => c.name.toLowerCase() === proposed.name.toLowerCase(),
  );
  if (found) return found.id;

  const { data: created, error } = await service
    .from('collections')
    .insert({
      user_id: userId,
      name: proposed.name,
      description: proposed.description,
      icon: proposed.icon ?? null,
      filter: {},
      is_default: false,
    })
    .select('id')
    .single();
  if (error || !created) {
    console.warn('create collection failed', error);
    return null;
  }
  return created.id;
}

/**
 * Top-level assigner. Combines:
 *   - the deterministic filter classifier results (already passed in
 *     `deterministicMatched` so we don't double-query),
 *   - an LLM pass when the deterministic step yielded only Inbox or nothing.
 */
export async function llmAssignCollections(
  service: SupabaseClient,
  opts: {
    nodeId: string;
    userId: string;
    extracted: Extracted;
    rawContent: string;
    tags: string[];
    /** Whether deterministic classifier already assigned non-default collections. */
    deterministicMatchedNonDefault: boolean;
  },
): Promise<{ added: number; created_collection: string | null }> {
  // If user already explicitly bucketed this node via filters, don't second-guess.
  if (opts.deterministicMatchedNonDefault) {
    return { added: 0, created_collection: null };
  }

  if ((opts.extracted.content?.length ?? 0) + (opts.rawContent?.length ?? 0) < MIN_CONTENT_FOR_LLM) {
    return { added: 0, created_collection: null };
  }

  const { data: collections } = await service
    .from('collections')
    .select('id, name, description, is_default')
    .eq('user_id', opts.userId);

  const all = (collections ?? []) as CollectionRow[];
  // Heavy curation → skip LLM creation, just possibly pick.
  if (all.length > MAX_LLM_COLLECTIONS_PER_USER) {
    // Still run the picker, but disallow new_collection
    const picked = await askLLM(all, opts.extracted, opts.rawContent, opts.tags);
    const ids = picked?.picked_ids ?? [];
    const added = await linkNodeToCollections(service, opts.nodeId, opts.userId, ids);
    return { added, created_collection: null };
  }

  const result = await askLLM(all, opts.extracted, opts.rawContent, opts.tags);
  if (!result) return { added: 0, created_collection: null };

  const toLink = [...result.picked_ids];
  let createdId: string | null = null;

  if (result.new_collection) {
    createdId = await getOrCreateCollection(service, opts.userId, result.new_collection);
    if (createdId) toLink.push(createdId);
  }

  if (toLink.length === 0) return { added: 0, created_collection: createdId };

  // Drop any existing Inbox-only membership so the node moves out of Inbox once
  // it has a thematic home. We only remove the default collection link.
  const defaultRow = all.find((c) => c.is_default);
  if (defaultRow) {
    await service
      .from('node_collections')
      .delete()
      .eq('node_id', opts.nodeId)
      .eq('collection_id', defaultRow.id);
  }

  const added = await linkNodeToCollections(service, opts.nodeId, opts.userId, toLink);
  return { added, created_collection: createdId };
}
