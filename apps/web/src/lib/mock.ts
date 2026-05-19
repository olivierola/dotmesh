/**
 * Mock in-memory store for dev without a backend.
 * Replace by real API calls once Supabase is up.
 */

export interface MockNode {
  id: string;
  source: string;
  source_url: string | null;
  source_app: string | null;
  content: string;
  summary: string | null;
  entities: Array<{ type: string; value: string; normalized: string }>;
  tags: string[];
  score: number | null;
  created_at: string;
  pinned: boolean;
  metadata?: {
    captureType?: 'hover' | 'attention' | 'reading' | 'ai_session' | 'search' | 'active_work' | 'manual';
    elementType?: 'text' | 'heading' | 'link' | 'image' | 'video' | 'code' | 'quote' | 'list-item';
    mediaUrl?: string;
    surroundingContext?: string;
    pageTitle?: string;
    capturedAt?: string;
    heading?: string;
    author?: string;
    reason?: string;
    [key: string]: unknown;
  };
  collection_ids?: string[];
}

const seedNodes: MockNode[] = [
  {
    id: 'n1',
    source: 'extension',
    source_url: 'https://claude.ai/chat/abc',
    source_app: 'claude.ai',
    content: 'Conversation about Project Falcon — Sophie wants less copy on onboarding, deadline June 15.',
    summary: 'Sophie (lead design) requested fewer words on onboarding for Project Falcon. Deadline June 15.',
    entities: [
      { type: 'PERSON', value: 'Sophie', normalized: 'sophie' },
      { type: 'PROJECT', value: 'Project Falcon', normalized: 'project falcon' },
      { type: 'DATE', value: 'June 15', normalized: '2026-06-15' },
    ],
    tags: ['ai_session', 'work'],
    score: 0.82,
    created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    pinned: false,
  },
  {
    id: 'n2',
    source: 'connector:gmail',
    source_url: null,
    source_app: 'gmail',
    content: 'Sent email to sophie@acme.com about copy revisions for the onboarding flow.',
    summary: 'Sent Sophie revised copy proposal for onboarding.',
    entities: [{ type: 'PERSON', value: 'Sophie', normalized: 'sophie' }],
    tags: ['email', 'sent'],
    score: 0.71,
    created_at: new Date(Date.now() - 26 * 3600_000).toISOString(),
    pinned: false,
  },
  {
    id: 'n3',
    source: 'extension',
    source_url: 'https://news.ycombinator.com/item?id=42',
    source_app: 'web',
    content: 'Long read: why agent memory matters — discusses cross-agent context and personal knowledge graphs.',
    summary: 'Article arguing personal cross-agent memory is the next major unlock for AI productivity.',
    entities: [
      { type: 'TOPIC', value: 'agent memory', normalized: 'agent memory' },
      { type: 'TOPIC', value: 'knowledge graph', normalized: 'knowledge graph' },
    ],
    tags: ['reading'],
    score: 0.65,
    created_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
    pinned: true,
  },
];

let store: MockNode[] = [...seedNodes];

export const mockApi = {
  listNodes(): Promise<{ nodes: MockNode[] }> {
    return Promise.resolve({ nodes: [...store].sort((a, b) => b.created_at.localeCompare(a.created_at)) });
  },
  createNode(input: { content: string; source: string }): Promise<MockNode> {
    const node: MockNode = {
      id: crypto.randomUUID(),
      source: input.source,
      source_url: null,
      source_app: null,
      content: input.content,
      summary: input.content.slice(0, 120),
      entities: [],
      tags: [],
      score: 1,
      created_at: new Date().toISOString(),
      pinned: false,
    };
    store = [node, ...store];
    return Promise.resolve(node);
  },
  search(query: string): Promise<{ results: Array<MockNode & { score: number }> }> {
    const q = query.toLowerCase();
    const hits = store
      .map((n) => {
        const hay = `${n.summary ?? ''} ${n.content} ${n.tags.join(' ')}`.toLowerCase();
        const score = hay.includes(q) ? 0.9 : 0;
        return { ...n, score };
      })
      .filter((n) => n.score > 0);
    return Promise.resolve({ results: hits });
  },
  deleteNode(id: string): Promise<void> {
    store = store.filter((n) => n.id !== id);
    return Promise.resolve();
  },
  updateNode(
    id: string,
    patch: {
      summary?: string;
      edited_summary?: string;
      tags?: string[];
      user_tags?: string[];
      pinned?: boolean;
    },
  ): Promise<void> {
    store = store.map((n) => (n.id === id ? { ...n, ...patch } : n));
    return Promise.resolve();
  },
};

export interface MockRule {
  id: string;
  rule_type: 'agent_acl' | 'tag_block' | 'domain_block' | 'time_window';
  target: string;
  action: 'allow' | 'deny' | 'redact';
  filter: { tags?: string[]; sources?: string[] };
  priority: number;
  enabled: boolean;
}

let rules: MockRule[] = [
  {
    id: 'r1',
    rule_type: 'agent_acl',
    target: 'chatgpt.com',
    action: 'deny',
    filter: { tags: ['personal', 'health'] },
    priority: 100,
    enabled: true,
  },
];

export const mockRules = {
  list: (): Promise<MockRule[]> => Promise.resolve([...rules]),
  create: (r: Omit<MockRule, 'id'>): Promise<MockRule> => {
    const created = { ...r, id: crypto.randomUUID() };
    rules = [...rules, created];
    return Promise.resolve(created);
  },
  remove: (id: string): Promise<void> => {
    rules = rules.filter((r) => r.id !== id);
    return Promise.resolve();
  },
  toggle: (id: string, enabled: boolean): Promise<void> => {
    rules = rules.map((r) => (r.id === id ? { ...r, enabled } : r));
    return Promise.resolve();
  },
};

export interface MockEdge {
  id: string;
  from_node: string;
  to_node: string;
  relation_type: 'inferred' | 'explicit' | 'temporal' | 'contradicts' | 'supersedes';
  confidence: number;
  shared_entity: string | null;
}

const seedEdges: MockEdge[] = [
  {
    id: 'e1',
    from_node: 'n1',
    to_node: 'n2',
    relation_type: 'inferred',
    confidence: 0.78,
    shared_entity: 'sophie',
  },
];

// ---------------- Dashboard analytics mock ----------------

export interface DailyMetric {
  date: string; // YYYY-MM-DD
  captures: number;
  injections: number;
  pulls: number;
}

export interface SourceBreakdown {
  source: string;
  count: number;
}

export interface AgentBreakdown {
  agent: string;
  injections: number;
  accept_rate: number;
}

export interface RecentInjection {
  id: string;
  target_agent: string;
  query_excerpt: string;
  nodes_used: number;
  accepted: boolean;
  created_at: string;
}

export interface DashboardSnapshot {
  totals: {
    nodes: number;
    edges: number;
    captures_today: number;
    captures_week: number;
    injections_today: number;
    injections_week: number;
    pulls_today: number;
    avg_score: number;
  };
  daily: DailyMetric[];
  by_source: SourceBreakdown[];
  by_agent: AgentBreakdown[];
  recent_nodes: MockNode[];
  recent_injections: RecentInjection[];
}

function pseudoRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function buildDailySeries(days = 30): DailyMetric[] {
  const out: DailyMetric[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000);
    const seed = d.getDate() + d.getMonth() * 31;
    out.push({
      date: d.toISOString().split('T')[0]!,
      captures: Math.round(10 + pseudoRandom(seed) * 30),
      injections: Math.round(5 + pseudoRandom(seed + 1) * 18),
      pulls: Math.round(8 + pseudoRandom(seed + 2) * 25),
    });
  }
  return out;
}

export const mockDashboard = {
  load(): Promise<DashboardSnapshot> {
    const daily = buildDailySeries(30);
    const lastDay = daily[daily.length - 1]!;
    const last7 = daily.slice(-7);
    const sum = (k: keyof DailyMetric) =>
      last7.reduce((acc, d) => acc + (d[k] as number), 0);

    const recentInjections: RecentInjection[] = [
      {
        id: 'inj1',
        target_agent: 'claude.ai',
        query_excerpt: 'Help me write to Sophie about the launch…',
        nodes_used: 3,
        accepted: true,
        created_at: new Date(Date.now() - 12 * 60_000).toISOString(),
      },
      {
        id: 'inj2',
        target_agent: 'chatgpt.com',
        query_excerpt: 'Summarize what I read this week on agent memory',
        nodes_used: 5,
        accepted: true,
        created_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      },
      {
        id: 'inj3',
        target_agent: 'gemini.google.com',
        query_excerpt: 'When is the Falcon deadline?',
        nodes_used: 2,
        accepted: false,
        created_at: new Date(Date.now() - 26 * 3600_000).toISOString(),
      },
    ];

    return Promise.resolve({
      totals: {
        nodes: store.length,
        edges: seedEdges.length,
        captures_today: lastDay.captures,
        captures_week: sum('captures'),
        injections_today: lastDay.injections,
        injections_week: sum('injections'),
        pulls_today: lastDay.pulls,
        avg_score: 0.71,
      },
      daily,
      by_source: [
        { source: 'extension', count: 142 },
        { source: 'connector:gmail', count: 38 },
        { source: 'connector:gcal', count: 24 },
        { source: 'connector:slack', count: 18 },
        { source: 'manual', count: 9 },
      ],
      by_agent: [
        { agent: 'claude.ai', injections: 42, accept_rate: 0.81 },
        { agent: 'chatgpt.com', injections: 31, accept_rate: 0.62 },
        { agent: 'gemini.google.com', injections: 9, accept_rate: 0.55 },
        { agent: 'cursor', injections: 14, accept_rate: 0.93 },
      ],
      recent_nodes: [...store]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 5),
      recent_injections: recentInjections,
    });
  },
};

export const mockGraph = {
  load(): Promise<{ nodes: MockNode[]; edges: MockEdge[] }> {
    return Promise.resolve({ nodes: [...store], edges: [...seedEdges] });
  },
};

// ---------------- Assistant chatbot mock ----------------

export interface MockChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cited_nodes: string[];
  created_at: string;
}

export interface MockChatSession {
  id: string;
  title: string;
  pinned: boolean;
  updated_at: string;
}

let mockSessions: MockChatSession[] = [
  {
    id: 's1',
    title: 'About Project Falcon',
    pinned: false,
    updated_at: new Date(Date.now() - 1.5 * 3600_000).toISOString(),
  },
];

const mockMessagesBySession: Record<string, MockChatMessage[]> = {
  s1: [
    {
      id: 'm1',
      role: 'user',
      content: "What's the latest on Sophie's feedback for Project Falcon?",
      cited_nodes: [],
      created_at: new Date(Date.now() - 1.6 * 3600_000).toISOString(),
    },
    {
      id: 'm2',
      role: 'assistant',
      content:
        'Sophie (lead design) asked for less copy on the onboarding screens for Project Falcon [1]. The deadline is June 15 [1], and the budget of €45k was approved with a mobile-first focus.',
      cited_nodes: ['n1'],
      created_at: new Date(Date.now() - 1.5 * 3600_000).toISOString(),
    },
  ],
};

function mockReply(question: string): { text: string; cited: string[]; hits: Array<{ index: number; id: string; summary: string; source: string }> } {
  const q = question.toLowerCase();
  const matches: MockNode[] = [];
  for (const n of store) {
    const hay = `${n.summary ?? ''} ${n.content} ${n.entities.map((e) => e.value).join(' ')}`.toLowerCase();
    if (q.split(/\s+/).some((w) => w.length > 3 && hay.includes(w))) {
      matches.push(n);
    }
  }
  const top = matches.slice(0, 3);
  if (top.length === 0) {
    return {
      text:
        "I couldn't find anything specific in your memory yet. Try asking about people, projects, or topics that appear in your timeline.",
      cited: [],
      hits: [],
    };
  }
  const summaryLine = top
    .map((n, i) => `[${i + 1}] ${n.summary ?? n.content.slice(0, 120)}`)
    .join(' ');
  return {
    text: `Based on your memory: ${summaryLine}`,
    cited: top.map((n) => n.id),
    hits: top.map((n, i) => ({
      index: i + 1,
      id: n.id,
      summary: n.summary ?? n.content.slice(0, 180),
      source: n.source,
    })),
  };
}

export const mockChat = {
  listSessions: (): Promise<MockChatSession[]> =>
    Promise.resolve(
      [...mockSessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    ),

  loadSession: (id: string): Promise<{ session: MockChatSession | null; messages: MockChatMessage[] }> =>
    Promise.resolve({
      session: mockSessions.find((s) => s.id === id) ?? null,
      messages: mockMessagesBySession[id] ?? [],
    }),

  createSession: (title: string): Promise<MockChatSession> => {
    const s: MockChatSession = {
      id: crypto.randomUUID(),
      title: title.slice(0, 60),
      pinned: false,
      updated_at: new Date().toISOString(),
    };
    mockSessions = [s, ...mockSessions];
    mockMessagesBySession[s.id] = [];
    return Promise.resolve(s);
  },

  deleteSession: (id: string): Promise<void> => {
    mockSessions = mockSessions.filter((s) => s.id !== id);
    delete mockMessagesBySession[id];
    return Promise.resolve();
  },

  /** Streams a fake assistant reply chunk by chunk. */
  async *sendMessage(
    sessionId: string | null,
    message: string,
  ): AsyncGenerator<
    | { type: 'meta'; session_id: string; hits: Array<{ index: number; id: string; summary: string; source: string }>; agent_used: 'daily_briefing' | 'follow_up' | 'meeting_prep' | null }
    | { type: 'delta'; text: string }
    | { type: 'done'; cited_nodes: string[] }
  > {
    let sid = sessionId;
    if (!sid) {
      const s = await mockChat.createSession(message);
      sid = s.id;
    }
    const userMsg: MockChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: message,
      cited_nodes: [],
      created_at: new Date().toISOString(),
    };
    mockMessagesBySession[sid] = [...(mockMessagesBySession[sid] ?? []), userMsg];

    const { text, cited, hits } = mockReply(message);
    yield { type: 'meta', session_id: sid, hits, agent_used: null };

    // Stream characters in small chunks to simulate streaming
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 4) chunks.push(text.slice(i, i + 4));
    for (const c of chunks) {
      await new Promise((r) => setTimeout(r, 12));
      yield { type: 'delta', text: c };
    }

    const assistantMsg: MockChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: text,
      cited_nodes: cited,
      created_at: new Date().toISOString(),
    };
    mockMessagesBySession[sid] = [...mockMessagesBySession[sid]!, assistantMsg];
    mockSessions = mockSessions.map((s) =>
      s.id === sid ? { ...s, updated_at: new Date().toISOString() } : s,
    );

    yield { type: 'done', cited_nodes: cited };
  },
};

export interface MockConnector {
  id: string;
  provider: string;
  status: 'active' | 'paused' | 'error';
  last_sync_at: string | null;
}

const connectors: MockConnector[] = [];

export const mockConnectors = {
  list: (): Promise<MockConnector[]> => Promise.resolve([...connectors]),
};
