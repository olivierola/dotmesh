/**
 * Unified API client.
 *
 * If VITE_USE_MOCK === 'true' (default in dev), all calls hit in-memory mock data.
 * Otherwise, calls go to Supabase Edge Functions with the user JWT.
 *
 * The interface is identical regardless of mode.
 */

import { supabase } from './supabase';
import { mockApi, mockGraph, mockRules, mockConnectors, mockDashboard, mockChat } from './mock';
import type {
  MockNode,
  MockEdge,
  MockRule,
  MockConnector,
  DashboardSnapshot,
  MockChatSession,
  MockChatMessage,
} from './mock';

export interface ChatHit {
  index: number;
  id: string;
  summary: string;
  source: string;
  source_url?: string | null;
}

export type AgentUsed = 'daily_briefing' | 'follow_up' | 'meeting_prep';

export interface InsightCount {
  label: string;
  count: number;
}

export interface InsightPayload {
  window_days: number;
  node_count: number;
  themes: InsightCount[];
  people: InsightCount[];
  top_authors: InsightCount[];
  top_sites: InsightCount[];
  type_breakdown: InsightCount[];
  top_keywords: InsightCount[];
  decisions: Array<{ text: string; node_id: string }>;
  expiring: Array<{ node_id: string; ttl_at: string }>;
  narrative: string | null;
  generated_at: string;
}

export type ChatStreamEvent =
  | { type: 'meta'; session_id: string; hits: ChatHit[]; agent_used: AgentUsed | null }
  | { type: 'delta'; text: string }
  | { type: 'done'; cited_nodes: string[] };

// USE_MOCK is OFF by default. Only the explicit string "true" activates it.
// This guarantees prod / staging always hit the real backend even if the env var
// is accidentally omitted at build time.
const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';
const API_BASE =
  (import.meta.env.VITE_API_URL as string) ||
  `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1`;

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.session?.access_token ?? ''}`,
  };
}

async function realFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(await authHeaders()), ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`${path} ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export interface ListNodesResponse {
  nodes: MockNode[];
  limit?: number;
  offset?: number;
}

export interface SearchFilters {
  tags?: string[];
  source?: string;
  since?: string;
  node_types?: string[];
  collection_id?: string;
  author?: string;
}

export interface SearchResponse {
  results: Array<MockNode & { score: number }>;
  reranked?: boolean;
}

export interface GraphCollection {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  is_default: boolean;
  node_count?: number;
}

export const api = {
  isMock: USE_MOCK,

  // ----- Nodes -----
  async listNodes(opts: { limit?: number; offset?: number; source?: string } = {}): Promise<ListNodesResponse> {
    if (USE_MOCK) return mockApi.listNodes();
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    if (opts.source) params.set('source', opts.source);
    return realFetch<ListNodesResponse>(`/nodes?${params}`);
  },

  async createNode(input: {
    content: string;
    source: string;
    tags?: string[];
    ttl?: string;
    pinned?: boolean;
  }): Promise<MockNode> {
    if (USE_MOCK) {
      const created = await mockApi.createNode({ content: input.content, source: input.source });
      // Apply post-create patch for tags/pinned/ttl in mock mode.
      if (input.tags?.length || input.pinned || input.ttl) {
        await mockApi.updateNode(created.id, {
          tags: input.tags ?? created.tags,
          pinned: input.pinned ?? false,
        });
        return { ...created, tags: input.tags ?? created.tags, pinned: input.pinned ?? false };
      }
      return created;
    }
    return realFetch<MockNode>('/nodes', { method: 'POST', body: JSON.stringify(input) });
  },

  async deleteNode(id: string): Promise<void> {
    if (USE_MOCK) return mockApi.deleteNode(id);
    await realFetch(`/nodes/${id}`, { method: 'DELETE' });
  },

  async updateNode(
    id: string,
    patch: {
      summary?: string;
      edited_summary?: string;
      tags?: string[];
      user_tags?: string[];
      pinned?: boolean;
    },
  ): Promise<void> {
    if (USE_MOCK) {
      // mock supports pin + inline edit via direct store mutation
      // implementation: forward through mockApi if available, else no-op
      const m = mockApi as unknown as {
        updateNode?: (id: string, p: typeof patch) => Promise<void>;
      };
      if (m.updateNode) await m.updateNode(id, patch);
      return;
    }
    await realFetch(`/nodes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async search(
    query: string,
    topK = 20,
    opts: { filters?: SearchFilters; rerank?: boolean } = {},
  ): Promise<SearchResponse> {
    if (USE_MOCK) return mockApi.search(query);
    return realFetch<SearchResponse>('/search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        top_k: topK,
        rerank: opts.rerank ?? true,
        filters: opts.filters,
      }),
    });
  },

  // ----- Dashboard -----
  async loadDashboard(): Promise<DashboardSnapshot> {
    if (USE_MOCK) return mockDashboard.load();
    return realFetch<DashboardSnapshot>('/dashboard');
  },

  // ----- Graph -----
  async loadGraph(): Promise<{
    nodes: MockNode[];
    edges: MockEdge[];
    collections: GraphCollection[];
  }> {
    if (USE_MOCK) {
      const g = await mockGraph.load();
      return { ...g, collections: [] };
    }
    const [nodes, edgesRaw, collectionsRes] = await Promise.all([
      realFetch<ListNodesResponse>('/nodes?limit=500&with_collections=true'),
      supabase.from('context_edges').select('*'),
      realFetch<{ collections: GraphCollection[] }>('/collections').catch(() => ({
        collections: [] as GraphCollection[],
      })),
    ]);
    return {
      nodes: nodes.nodes,
      edges: (edgesRaw.data ?? []) as unknown as MockEdge[],
      collections: collectionsRes.collections ?? [],
    };
  },

  // ----- Rules -----
  async listRules(): Promise<MockRule[]> {
    if (USE_MOCK) return mockRules.list();
    const { rules } = await realFetch<{ rules: MockRule[] }>('/rules');
    return rules;
  },
  async createRule(r: Omit<MockRule, 'id'>): Promise<MockRule> {
    if (USE_MOCK) return mockRules.create(r);
    const { rule } = await realFetch<{ rule: MockRule }>('/rules', {
      method: 'POST',
      body: JSON.stringify(r),
    });
    return rule;
  },
  async deleteRule(id: string): Promise<void> {
    if (USE_MOCK) return mockRules.remove(id);
    await realFetch(`/rules/${id}`, { method: 'DELETE' });
  },
  async toggleRule(id: string, enabled: boolean): Promise<void> {
    if (USE_MOCK) return mockRules.toggle(id, enabled);
    await realFetch(`/rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
  },

  // ----- Connectors -----
  async listConnectors(): Promise<MockConnector[]> {
    if (USE_MOCK) return mockConnectors.list();
    const { data } = await supabase
      .from('connectors')
      .select('id, provider, status, last_sync_at, error_message');
    return (data ?? []) as MockConnector[];
  },
  async startConnectorAuth(
    provider: 'gmail' | 'gcal' | 'slack' | 'notion',
  ): Promise<{ auth_url: string }> {
    if (USE_MOCK) throw new Error('mock: OAuth flow not available');
    const fn = {
      gmail: 'connectors-gmail-auth',
      gcal: 'connectors-gcal-auth',
      slack: 'connectors-slack-auth',
      notion: 'connectors-notion-auth',
    }[provider];
    return realFetch<{ auth_url: string }>(`/${fn}?action=start`);
  },

  // ----- Billing -----
  async billingCheckout(input: {
    tier: 'personal' | 'pro';
    interval: 'month' | 'year';
  }): Promise<{ url: string }> {
    if (USE_MOCK) {
      window.alert(`Mock: would redirect to Stripe Checkout for ${input.tier} (${input.interval})`);
      return { url: '#' };
    }
    return realFetch<{ url: string }>('/billing-checkout', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async billingPortal(): Promise<{ url: string }> {
    if (USE_MOCK) {
      window.alert('Mock: would redirect to Stripe Customer Portal');
      return { url: '#' };
    }
    return realFetch<{ url: string }>('/billing-portal', { method: 'POST' });
  },

  // ----- User prefs -----
  async loadPrefs(): Promise<{
    notification_prefs: Record<string, boolean>;
    ui_prefs: Record<string, unknown>;
  }> {
    if (USE_MOCK) {
      const raw = localStorage.getItem('mesh:prefs');
      if (raw) return JSON.parse(raw) as {
        notification_prefs: Record<string, boolean>;
        ui_prefs: Record<string, unknown>;
      };
      return {
        notification_prefs: {
          weekly_digest_email: true,
          realtime_in_app: true,
          product_updates: false,
          security_alerts: true,
        },
        ui_prefs: {
          theme: 'dark',
          compact_density: false,
          injection_auto_accept_ms: 2000,
        },
      };
    }
    return realFetch('/user-prefs');
  },

  async updatePrefs(patch: {
    notification_prefs?: Record<string, boolean>;
    ui_prefs?: Record<string, unknown>;
  }): Promise<void> {
    if (USE_MOCK) {
      const cur = await this.loadPrefs();
      const next = {
        notification_prefs: { ...cur.notification_prefs, ...(patch.notification_prefs ?? {}) },
        ui_prefs: { ...cur.ui_prefs, ...(patch.ui_prefs ?? {}) },
      };
      localStorage.setItem('mesh:prefs', JSON.stringify(next));
      return;
    }
    await realFetch('/user-prefs', { method: 'PATCH', body: JSON.stringify(patch) });
  },

  // ----- Assistant chat -----
  async listChatSessions(): Promise<MockChatSession[]> {
    if (USE_MOCK) return mockChat.listSessions();
    const { sessions } = await realFetch<{ sessions: MockChatSession[] }>('/chat-sessions');
    return sessions;
  },
  async loadChatSession(
    id: string,
  ): Promise<{ session: MockChatSession | null; messages: MockChatMessage[] }> {
    if (USE_MOCK) return mockChat.loadSession(id);
    return realFetch<{ session: MockChatSession; messages: MockChatMessage[] }>(
      `/chat-sessions/${id}`,
    );
  },
  async deleteChatSession(id: string): Promise<void> {
    if (USE_MOCK) return mockChat.deleteSession(id);
    await realFetch(`/chat-sessions/${id}`, { method: 'DELETE' });
  },

  /**
   * Stream a chat reply.
   * Yields events; caller is responsible for state updates.
   */
  async *chatStream(
    sessionId: string | null,
    message: string,
  ): AsyncGenerator<ChatStreamEvent> {
    if (USE_MOCK) {
      yield* mockChat.sendMessage(sessionId, message);
      return;
    }
    const res = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({ session_id: sessionId, message }),
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`chat ${res.status}: ${detail}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let metaSent = false;
    let citedNodes: string[] = [];

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      if (!metaSent && buf.includes('\n')) {
        const newlineIdx = buf.indexOf('\n');
        const firstLine = buf.slice(0, newlineIdx);
        buf = buf.slice(newlineIdx + 1);
        if (firstLine.startsWith('META ')) {
          try {
            const meta = JSON.parse(firstLine.slice(5)) as {
              session_id: string;
              cited_nodes: string[];
              hits: ChatHit[];
              agent_used: AgentUsed | null;
            };
            citedNodes = meta.cited_nodes;
            metaSent = true;
            yield {
              type: 'meta',
              session_id: meta.session_id,
              hits: meta.hits,
              agent_used: meta.agent_used,
            };
          } catch {
            metaSent = true;
          }
        }
      }

      if (metaSent && buf.length > 0) {
        yield { type: 'delta', text: buf };
        buf = '';
      }
    }
    yield { type: 'done', cited_nodes: citedNodes };
  },

  // ----- Agents -----
  async loadAgents(): Promise<{
    runs: Array<{
      id: string;
      agent_type: 'daily_briefing' | 'follow_up' | 'meeting_prep' | 'custom';
      status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
      output: {
        title: string;
        summary: string;
        items?: Array<{ text: string; node_id?: string; due?: string | null }>;
        cited_nodes?: string[];
        metadata?: Record<string, unknown>;
      } | null;
      error_message: string | null;
      created_at: string;
      finished_at: string | null;
      latency_ms: number | null;
    }>;
    prefs: Record<string, { enabled?: boolean; hour_utc?: number; lead_minutes?: number }>;
  }> {
    if (USE_MOCK) {
      const now = new Date();
      return {
        runs: [
          {
            id: 'ar1',
            agent_type: 'daily_briefing',
            status: 'success',
            output: {
              title: 'Three things to do today',
              summary:
                'Sophie expects the onboarding copy by tomorrow. Falcon kickoff at 11. You promised a follow-up on the design review.',
              items: [
                { text: 'Send Sophie the revised onboarding copy', due: null },
                { text: 'Prep for Falcon kickoff (11am)', due: null },
                { text: 'Reply to design review thread', due: null },
              ],
              cited_nodes: ['n1'],
            },
            error_message: null,
            created_at: new Date(now.getTime() - 3 * 3600_000).toISOString(),
            finished_at: new Date(now.getTime() - 3 * 3600_000 + 4_000).toISOString(),
            latency_ms: 4123,
          },
        ],
        prefs: {
          daily_briefing: { enabled: true, hour_utc: 6 },
          follow_up: { enabled: true },
          meeting_prep: { enabled: true, lead_minutes: 30 },
        },
      };
    }
    return realFetch('/agents');
  },

  async runAgent(type: 'daily_briefing' | 'follow_up' | 'meeting_prep'): Promise<void> {
    if (USE_MOCK) {
      window.alert(`Mock: would trigger ${type}`);
      return;
    }
    await realFetch('/agents/run', { method: 'POST', body: JSON.stringify({ type }) });
  },

  async updateAgentPrefs(
    patch: Record<string, Partial<{ enabled: boolean; hour_utc: number; lead_minutes: number }>>,
  ): Promise<void> {
    if (USE_MOCK) {
      const cur = await this.loadAgents();
      localStorage.setItem(
        'mesh:agent_prefs_mock',
        JSON.stringify({ ...cur.prefs, ...patch }),
      );
      return;
    }
    await realFetch('/agents/prefs', { method: 'PATCH', body: JSON.stringify(patch) });
  },

  // ----- Collections -----
  async listCollections(): Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
      rule_prompt: string | null;
      filter: Record<string, unknown>;
      is_default: boolean;
      icon: string | null;
      color: string | null;
      pinned: boolean;
      sort_order: number;
      node_count: number;
      last_node_at: string | null;
      created_at: string;
      updated_at: string;
    }>
  > {
    const { collections } = await realFetch<{
      collections: Array<{
        id: string;
        name: string;
        description: string | null;
        rule_prompt: string | null;
        filter: Record<string, unknown>;
        is_default: boolean;
        icon: string | null;
        color: string | null;
        pinned: boolean;
        sort_order: number;
        node_count: number;
        last_node_at: string | null;
        created_at: string;
        updated_at: string;
      }>;
    }>('/collections');
    return collections;
  },

  async createCollection(input: {
    name: string;
    description?: string;
    rule_prompt?: string;
    icon?: string;
    color?: string;
  }): Promise<{ id: string }> {
    const { collection } = await realFetch<{ collection: { id: string } }>('/collections', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return collection;
  },

  async updateCollection(
    id: string,
    patch: {
      name?: string;
      description?: string;
      rule_prompt?: string;
      icon?: string;
      color?: string;
      pinned?: boolean;
      sort_order?: number;
    },
  ): Promise<void> {
    await realFetch(`/collections/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  },

  async deleteCollection(id: string): Promise<void> {
    await realFetch(`/collections/${id}`, { method: 'DELETE' });
  },

  async getCollection(id: string): Promise<{
    id: string;
    name: string;
    description: string | null;
    rule_prompt: string | null;
    filter: Record<string, unknown>;
    is_default: boolean;
    icon: string | null;
    color: string | null;
    pinned: boolean;
    node_count: number;
    last_node_at: string | null;
    created_at: string;
  }> {
    const { collection } = await realFetch<{ collection: any }>(`/collections/${id}`);
    return collection;
  },

  async listCollectionNodes(
    id: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{
    nodes: Array<{
      id: string;
      content: string;
      summary: string | null;
      tags: string[];
      source: string;
      source_url: string | null;
      source_app: string | null;
      score: number | null;
      created_at: string;
      pinned: boolean;
      node_type: string | null;
      metadata: Record<string, unknown>;
      link_source: 'auto' | 'manual' | 'llm' | string;
    }>;
    total: number;
  }> {
    const params = new URLSearchParams();
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.offset) params.set('offset', String(opts.offset));
    return realFetch(`/collections/${id}/nodes?${params}`);
  },

  async previewCollectionRules(
    rule_prompt: string,
  ): Promise<{
    filter: Record<string, unknown>;
    sampled: number;
    matched: number;
  }> {
    return realFetch('/collections/preview', {
      method: 'POST',
      body: JSON.stringify({ rule_prompt }),
    });
  },

  async reclassifyCollection(id: string): Promise<{ ok: boolean; matched: number }> {
    return realFetch(`/collections/${id}/reclassify`, { method: 'POST' });
  },

  async backfillHierarchy(opts: { limit?: number; offset?: number } = {}): Promise<{
    ok: boolean;
    scanned: number;
    pages_linked: number;
    nav_linked: number;
    sessions_linked: number;
    next_offset: number;
    done: boolean;
    errors: string[];
  }> {
    return realFetch('/backfill-hierarchy', {
      method: 'POST',
      body: JSON.stringify(opts),
    });
  },

  // ----- Custom instructions -----
  async listInstructions(): Promise<
    Array<{
      id: string;
      title: string;
      context: string | null;
      instruction: string;
      enabled: boolean;
      icon: string | null;
      color: string | null;
      sort_order: number;
      created_at: string;
      updated_at: string;
      indexed: boolean;
    }>
  > {
    const { instructions } = await realFetch<{
      instructions: Array<{
        id: string;
        title: string;
        context: string | null;
        instruction: string;
        enabled: boolean;
        icon: string | null;
        color: string | null;
        sort_order: number;
        created_at: string;
        updated_at: string;
        indexed: boolean;
      }>;
    }>('/instructions');
    return instructions;
  },

  async createInstruction(input: {
    title: string;
    context?: string;
    instruction: string;
    icon?: string;
    color?: string;
    enabled?: boolean;
  }): Promise<{ id: string }> {
    const { instruction } = await realFetch<{ instruction: { id: string } }>(
      '/instructions',
      { method: 'POST', body: JSON.stringify(input) },
    );
    return instruction;
  },

  async updateInstruction(
    id: string,
    patch: {
      title?: string;
      context?: string | null;
      instruction?: string;
      icon?: string | null;
      color?: string | null;
      enabled?: boolean;
      sort_order?: number;
    },
  ): Promise<void> {
    await realFetch(`/instructions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async deleteInstruction(id: string): Promise<void> {
    await realFetch(`/instructions/${id}`, { method: 'DELETE' });
  },

  async reclassifyOrphansWithLLM(): Promise<{
    ok: boolean;
    scanned: number;
    skipped?: number;
    reassigned: number;
    created: string[];
  }> {
    return realFetch('/collections/reclassify-orphans', { method: 'POST' });
  },

  // ----- Maintenance -----
  /**
   * Re-runs LLM summary + entity extraction + embeddings on up to ~100 of the
   * current user's nodes that are missing those fields or whose summary is a
   * raw URL / "[Page] …" placeholder. Idempotent — call again to process the
   * next batch.
   */
  async reprocessAll(): Promise<{
    ok: boolean;
    scanned: number;
    processed: number;
    embedded: number;
    edges_created: number;
    collections_assigned: number;
    errors: string[];
  }> {
    return realFetch('/reprocess-all', { method: 'POST' });
  },

  // ----- Insights (on-demand) -----
  async generateInsight(days = 7): Promise<{
    ok: boolean;
    days: number;
    node_count: number;
    insight: InsightPayload | null;
    note?: string;
  }> {
    return realFetch(`/insights-on-demand?days=${days}`, { method: 'POST' });
  },

  // ----- Account -----
  async exportAccount(): Promise<Blob> {
    if (USE_MOCK) {
      const data = {
        exported_at: new Date().toISOString(),
        note: 'Mock export — no real data',
        nodes: await mockApi.listNodes().then((r) => r.nodes),
      };
      return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    }
    const res = await fetch(`${API_BASE}/account-export`, { headers: await authHeaders() });
    if (!res.ok) throw new Error(`export ${res.status}`);
    return res.blob();
  },
  async completeOnboarding(): Promise<void> {
    localStorage.setItem('mesh:onboarded', new Date().toISOString());
    if (USE_MOCK) return;
    await realFetch('/onboarding-complete', { method: 'POST' });
  },

  async deleteAccount(): Promise<{ ok: boolean; hard_delete_at: string }> {
    if (USE_MOCK) {
      return {
        ok: true,
        hard_delete_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
      };
    }
    return realFetch<{ ok: boolean; hard_delete_at: string }>('/account-delete', {
      method: 'DELETE',
    });
  },
};
