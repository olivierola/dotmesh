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
}): Promise<{ node_id: string } | { error: string }> {
  try {
    const res = await apiFetch('/nodes', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
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
      instruction_ids?: string[];
    };
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
