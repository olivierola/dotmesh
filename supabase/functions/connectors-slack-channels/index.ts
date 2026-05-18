/**
 * GET   /functions/v1/connectors-slack-channels      list channels available to the user token
 * PATCH /functions/v1/connectors-slack-channels      body: { channels: string[], exclude_dms?: boolean }
 *
 * Lets the user opt in / out per channel for the Slack connector.
 */

import { z } from 'npm:zod@3.23.8';
import { handleCorsPreflight } from '../_shared/cors.ts';
import { requireUser, createServiceClient } from '../_shared/supabase.ts';
import { jsonResponse, errorResponse, parseJsonBody } from '../_shared/http.ts';
import { loadTokens } from '../_shared/connectors.ts';

const patchSchema = z.object({
  channels: z.array(z.string().min(1).max(40)).max(200),
  exclude_dms: z.boolean().optional(),
});

interface SlackChannel {
  id: string;
  name: string;
  is_private?: boolean;
  is_member?: boolean;
  num_members?: number;
}

Deno.serve(async (req) => {
  const cors = handleCorsPreflight(req);
  if (cors) return cors;

  try {
    const { userId, client } = await requireUser(req);
    const service = createServiceClient();

    if (req.method === 'GET') {
      const tokens = await loadTokens(service, userId, 'slack');
      if (!tokens) return errorResponse('connector_not_found', 404);

      const params = new URLSearchParams({
        limit: '100',
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
      });
      const res = await fetch(
        `https://slack.com/api/users.conversations?${params}`,
        { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      );
      if (!res.ok) return errorResponse('slack_failed', 502, await res.text());
      const data = (await res.json()) as { ok: boolean; channels?: SlackChannel[]; error?: string };
      if (!data.ok) return errorResponse(`slack_error:${data.error}`, 502);

      const { data: conn } = await client
        .from('connectors')
        .select('sync_settings')
        .eq('provider', 'slack')
        .maybeSingle();
      const selected = ((conn?.sync_settings as { channels?: string[] } | null)?.channels ?? []) as string[];

      return jsonResponse({
        channels: (data.channels ?? [])
          .filter((c) => c.is_member !== false)
          .map((c) => ({
            id: c.id,
            name: c.name,
            is_private: c.is_private ?? false,
            num_members: c.num_members ?? null,
            selected: selected.includes(c.id),
          })),
      });
    }

    if (req.method === 'PATCH') {
      const raw = await parseJsonBody<unknown>(req);
      const parsed = patchSchema.safeParse(raw);
      if (!parsed.success) return errorResponse('invalid_payload', 400, parsed.error.format());

      const { data: existing } = await client
        .from('connectors')
        .select('sync_settings')
        .eq('provider', 'slack')
        .maybeSingle();
      const prev = (existing?.sync_settings ?? {}) as Record<string, unknown>;
      const next = {
        ...prev,
        channels: parsed.data.channels,
        exclude_dms: parsed.data.exclude_dms ?? prev.exclude_dms ?? true,
      };
      const { error } = await client
        .from('connectors')
        .update({ sync_settings: next })
        .eq('provider', 'slack');
      if (error) return errorResponse('update_failed', 500, error);
      return jsonResponse({ ok: true, channels: parsed.data.channels.length });
    }

    return errorResponse('method_not_allowed', 405);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('slack-channels error', e);
    return errorResponse('internal_error', 500);
  }
});
