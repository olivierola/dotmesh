import { getSetting } from './db';
import { ensureFreshAuth, forceRefreshAuth, clearAuth } from './auth';

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const apiBase = await getSetting<string>(
    'api_base',
    (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:54321/functions/v1',
  );
  const auth = await ensureFreshAuth();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (auth?.accessToken) {
    headers.Authorization = `Bearer ${auth.accessToken}`;
  }
  return fetch(`${apiBase}${path}`, { ...init, headers });
}

export async function pushNode(payload: {
  content: string;
  source: string;
  source_url?: string;
  source_app?: string;
  tags?: string[];
  score?: number;
  sensitivity?: number;
  metadata?: Record<string, unknown>;
  fingerprint?: string;
}): Promise<{ node_id: string } | { error: string }> {
  const attempt = async () =>
    apiFetch('/nodes', { method: 'POST', body: JSON.stringify(payload) });

  try {
    let res = await attempt();
    // If the user's stored JWT has been invalidated (Supabase Auth rotated
    // its JWKS, or the session was nuked server-side), the first call
    // returns 401 with an "asymmetric jwt" / "invalid jwt" body. Force a
    // refresh and retry once before giving up; the user shouldn't have
    // to sign back in just because Supabase rolled keys in the background.
    if (res.status === 401) {
      const txt = await res.clone().text().catch(() => '');
      const looksLikeAuthRotation =
        /asymmetric|invalid[_ ]jwt|jwt expired/i.test(txt);
      if (looksLikeAuthRotation) {
        console.warn('[Mesh] pushNode 401 with stale JWT — refreshing and retrying');
        const refreshed = await forceRefreshAuth();
        if (refreshed) {
          res = await attempt();
        } else {
          // Refresh failed too → the refresh_token is dead, only a real
          // re-login can recover. Wipe local auth so the popup prompts.
          await clearAuth();
        }
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[Mesh] pushNode failed', res.status, text);
      return { error: `${res.status} ${text.slice(0, 120) || res.statusText}` };
    }
    return (await res.json()) as { node_id: string };
  } catch (e) {
    console.warn('[Mesh] pushNode error', e);
    return { error: (e as Error).message || 'network error' };
  }
}

export interface InjectedItem {
  kind: 'instruction' | 'node';
  id: string;
  title: string;
  node_type?: string;
  score?: number;
  full_text?: string;
  source_url?: string | null;
}

export async function inject(
  query: string,
  targetAgent: string,
): Promise<{
  should_inject: boolean;
  context_block: string | null;
  node_ids: string[];
  /** IDs of custom instructions that were matched and embedded in the
   *  context_block. Useful for telemetry; the block already contains them. */
  instruction_ids?: string[];
  /** Typed descriptors used by the content script to render coloured
   *  badges above the chatbot's user-message bubble after submission. */
  injected_items?: InjectedItem[];
  reason?: string;
} | null> {
  try {
    const res = await apiFetch('/inject', {
      method: 'POST',
      body: JSON.stringify({ query, target_agent: targetAgent }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn('[Mesh] inject HTTP error', res.status, detail.slice(0, 200));
      return null;
    }
    const data = (await res.json()) as {
      should_inject: boolean;
      context_block: string | null;
      node_ids: string[];
      instruction_ids?: string[];
      injected_items?: InjectedItem[];
      reason?: string;
      debug?: Record<string, unknown>;
    };
    console.log('[Mesh] inject server reason:', data.reason ?? '(none)');
    if (data.debug) console.log('[Mesh] inject server debug:', data.debug);
    return data;
  } catch (e) {
    console.warn('[Mesh] inject error', e);
    return null;
  }
}

/**
 * Returns true if the user has at least one enabled custom instruction.
 * Used by the trigger scorer to keep the /inject path warm even when no
 * memory keyword matches (instructions are typically prompt-agnostic).
 */
export async function fetchHasEnabledInstructions(): Promise<boolean> {
  try {
    const res = await apiFetch('/instructions');
    if (!res.ok) return false;
    const data = (await res.json()) as {
      instructions: Array<{ enabled: boolean }>;
    };
    return (data.instructions ?? []).some((i) => i.enabled);
  } catch {
    return false;
  }
}

/**
 * Fetch the user's domain-block rules from the server. The extension already
 * has a hardcoded sensitive list; this adds the user's own additions (managed
 * from the Rules page on the web app). Returns just the domain strings.
 */
export async function fetchBlockedDomains(): Promise<string[]> {
  try {
    const res = await apiFetch('/rules');
    if (!res.ok) return [];
    const data = (await res.json()) as {
      rules: Array<{
        rule_type: string;
        target: string;
        action: string;
        enabled: boolean;
      }>;
    };
    return (data.rules ?? [])
      .filter((r) => r.rule_type === 'domain_block' && r.enabled && r.action === 'deny')
      .map((r) => r.target.toLowerCase());
  } catch {
    return [];
  }
}

/** Fast cached recent-node fingerprints for the trigger scorer. */
export async function fetchRecentNodeKeywords(): Promise<string[]> {
  try {
    const res = await apiFetch('/nodes?limit=50');
    if (!res.ok) return [];
    const data = (await res.json()) as {
      nodes: Array<{
        summary: string | null;
        content: string;
        entities: Array<{ value: string; normalized: string }>;
        tags: string[];
      }>;
    };
    const set = new Set<string>();
    for (const n of data.nodes) {
      for (const e of n.entities ?? []) {
        if (e.normalized) set.add(e.normalized.toLowerCase());
      }
      for (const t of n.tags ?? []) {
        set.add(t.toLowerCase());
      }
    }
    return Array.from(set);
  } catch {
    return [];
  }
}
