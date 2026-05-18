import { getSetting } from './db';
import { ensureFreshAuth } from './auth';

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
}): Promise<{ node_id: string } | null> {
  try {
    const res = await apiFetch('/nodes', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn('pushNode failed', res.status, await res.text());
      return null;
    }
    return (await res.json()) as { node_id: string };
  } catch (e) {
    console.warn('pushNode error', e);
    return null;
  }
}

export async function inject(
  query: string,
  targetAgent: string,
): Promise<{
  should_inject: boolean;
  context_block: string | null;
  node_ids: string[];
} | null> {
  try {
    const res = await apiFetch('/inject', {
      method: 'POST',
      body: JSON.stringify({ query, target_agent: targetAgent }),
    });
    if (!res.ok) return null;
    return (await res.json()) as {
      should_inject: boolean;
      context_block: string | null;
      node_ids: string[];
    };
  } catch (e) {
    console.warn('inject error', e);
    return null;
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
