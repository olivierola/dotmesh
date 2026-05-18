/**
 * Match a freshly processed node against the user's collection filters and
 * insert rows in node_collections.
 *
 * Falls back to the user's "Inbox" (is_default = true) if nothing matches.
 *
 * Uses the `node_matches_filter` SQL helper for deterministic, cheap evaluation.
 * No LLM call here.
 */

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';

interface CollectionRow {
  id: string;
  filter: Record<string, unknown>;
  is_default: boolean;
}

export async function classifyNodeIntoCollections(
  service: SupabaseClient,
  nodeId: string,
  userId: string,
): Promise<number> {
  const { data: collections, error } = await service
    .from('collections')
    .select('id, filter, is_default')
    .eq('user_id', userId);

  if (error) {
    console.warn('classifier: list collections failed', error);
    return 0;
  }

  const all = (collections ?? []) as CollectionRow[];
  if (all.length === 0) return 0;

  const matchedIds: string[] = [];
  const defaultRow = all.find((c) => c.is_default);

  // Evaluate non-default collections
  for (const c of all) {
    if (c.is_default) continue;
    if (!c.filter || Object.keys(c.filter).length === 0) continue;
    const { data: ok } = await service.rpc('node_matches_filter', {
      p_node_id: nodeId,
      p_filter: c.filter,
    });
    if (ok === true) matchedIds.push(c.id);
  }

  // Fallback to Inbox if nothing matched
  if (matchedIds.length === 0 && defaultRow) {
    matchedIds.push(defaultRow.id);
  }

  if (matchedIds.length === 0) return 0;

  const rows = matchedIds.map((collection_id) => ({
    node_id: nodeId,
    collection_id,
    user_id: userId,
    source: 'auto',
  }));

  const { error: insertErr } = await service
    .from('node_collections')
    .upsert(rows, { onConflict: 'node_id,collection_id', ignoreDuplicates: true });

  if (insertErr) {
    console.warn('classifier insert failed', insertErr);
    return 0;
  }

  return matchedIds.length;
}
