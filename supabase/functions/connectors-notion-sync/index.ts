/**
 * Notion sync worker.
 *
 * Uses the search API to find pages recently edited by the user since last sync,
 * then fetches each page's content (blocks API, flattened to text).
 */

import { handleCorsPreflight } from '../_shared/cors.ts';
import { createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { loadTokens, updateSyncState } from '../_shared/connectors.ts';

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

interface SyncInput {
  user_id: string;
}

interface NotionBlock {
  type: string;
  paragraph?: { rich_text: Array<{ plain_text: string }> };
  heading_1?: { rich_text: Array<{ plain_text: string }> };
  heading_2?: { rich_text: Array<{ plain_text: string }> };
  heading_3?: { rich_text: Array<{ plain_text: string }> };
  bulleted_list_item?: { rich_text: Array<{ plain_text: string }> };
  numbered_list_item?: { rich_text: Array<{ plain_text: string }> };
  to_do?: { rich_text: Array<{ plain_text: string }> };
  quote?: { rich_text: Array<{ plain_text: string }> };
}

interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, { title?: Array<{ plain_text: string }> }>;
}

async function notionFetch<T>(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<T | null> {
  const res = await fetch(`${NOTION}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    console.warn('notion api', path, res.status, await res.text().catch(() => ''));
    return null;
  }
  return (await res.json()) as T;
}

function richText(arr?: Array<{ plain_text: string }>): string {
  return (arr ?? []).map((r) => r.plain_text).join('');
}

function blockText(b: NotionBlock): string {
  switch (b.type) {
    case 'paragraph':
      return richText(b.paragraph?.rich_text);
    case 'heading_1':
      return `# ${richText(b.heading_1?.rich_text)}`;
    case 'heading_2':
      return `## ${richText(b.heading_2?.rich_text)}`;
    case 'heading_3':
      return `### ${richText(b.heading_3?.rich_text)}`;
    case 'bulleted_list_item':
      return `- ${richText(b.bulleted_list_item?.rich_text)}`;
    case 'numbered_list_item':
      return `1. ${richText(b.numbered_list_item?.rich_text)}`;
    case 'to_do':
      return `[ ] ${richText(b.to_do?.rich_text)}`;
    case 'quote':
      return `> ${richText(b.quote?.rich_text)}`;
    default:
      return '';
  }
}

function pageTitle(p: NotionPage): string {
  for (const v of Object.values(p.properties)) {
    if (v.title) return richText(v.title);
  }
  return '(untitled)';
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method_not_allowed', 405);

  const auth = req.headers.get('Authorization') ?? '';
  if (auth !== `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`) {
    return errorResponse('forbidden', 403);
  }

  try {
    const { user_id } = await parseJsonBody<SyncInput>(req);
    const service = createServiceClient();
    const tokens = await loadTokens(service, user_id, 'notion');
    if (!tokens) return errorResponse('connector_not_found', 404);

    const { data: conn } = await service
      .from('connectors')
      .select('last_sync_at')
      .eq('user_id', user_id)
      .eq('provider', 'notion')
      .maybeSingle();
    const sinceMs = conn?.last_sync_at
      ? new Date(conn.last_sync_at).getTime()
      : Date.now() - 7 * 86400_000;

    // Find pages recently edited
    const search = await notionFetch<{ results: NotionPage[] }>(tokens.access_token, '/search', {
      method: 'POST',
      body: JSON.stringify({
        filter: { value: 'page', property: 'object' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 30,
      }),
    });

    let imported = 0;
    for (const page of search?.results ?? []) {
      if (new Date(page.last_edited_time).getTime() < sinceMs) break;

      const blocks = await notionFetch<{ results: NotionBlock[] }>(
        tokens.access_token,
        `/blocks/${page.id}/children?page_size=80`,
      );
      const text = (blocks?.results ?? [])
        .map(blockText)
        .filter(Boolean)
        .join('\n')
        .slice(0, 6000);
      if (text.length < 50) continue;

      const fingerprint = await sha256Hex(`notion|${page.id}|${page.last_edited_time}`);
      const content = `[Notion page] ${pageTitle(page)}\n\n${text}`;
      const { data: inserted } = await service
        .from('context_nodes')
        .upsert(
          {
            user_id,
            source: 'connector:notion',
            source_url: page.url,
            source_app: 'notion',
            content,
            tags: ['notion', 'doc'],
            acl_agents: ['*'],
            fingerprint,
            metadata: { page_id: page.id, last_edited: page.last_edited_time },
          },
          { onConflict: 'user_id,fingerprint', ignoreDuplicates: true },
        )
        .select('id')
        .maybeSingle();
      if (inserted?.id) {
        imported++;
        fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/process-node`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ node_id: inserted.id }),
        }).catch(() => {});
      }
    }
    await updateSyncState(service, user_id, 'notion', null);
    return jsonResponse({ ok: true, imported });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('notion-sync error', e);
    return errorResponse('internal_error', 500);
  }
});
