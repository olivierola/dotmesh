import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  api,
  type ChatHit,
  type AgentUsed,
  type InsightPayload,
  type InsightCount,
} from '@/lib/api-client';
import { supabase } from '@/lib/supabase';
import type { MockChatMessage, MockChatSession } from '@/lib/mock';
import ChatInput, { type ChatInputPayload } from '@/components/ui/chat-input';

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cited_nodes: string[];
  hits?: ChatHit[];
  agent_used?: AgentUsed | null;
  insight?: InsightPayload | null;
  created_at: string;
  streaming?: boolean;
}

const SUGGESTIONS = [
  'What did I read this week about agent memory?',
  'Summarize my last conversations with Sophie.',
  'What deadlines do I have coming up?',
  'Generate my insights for the week.',
];

/**
 * Detect whether the user is asking for an insight digest. Returns the
 * desired window in days, or null if no insight intent.
 */
function detectInsightIntent(text: string): number | null {
  const lower = text.toLowerCase();
  const isInsight =
    /\b(insight|insights|digest|résum[ée]|recap|briefing|wrap[- ]?up|debrief)\b/i.test(lower);
  if (!isInsight) return null;
  // Window heuristic: month / week / Nd
  if (/\b(month|mois|30\s?d|monthly)\b/.test(lower)) return 30;
  if (/\b(year|année|annuel|annual|365)\b/.test(lower)) return 365;
  const m = lower.match(/(\d+)\s*(day|jour)/);
  if (m) {
    const n = parseInt(m[1]!, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 365);
  }
  return 7;
}

export default function AssistantPage() {
  const qc = useQueryClient();
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: sessions } = useQuery({
    queryKey: ['chat-sessions'],
    queryFn: () => api.listChatSessions(),
  });

  useEffect(() => {
    if (!activeSession) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { messages: rows } = await api.loadChatSession(activeSession);
      if (cancelled) return;
      setMessages(
        rows.map((r) => uiMessageFromDb(r)),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSession]);

  // Realtime: invalidate the sessions list when chat_sessions or chat_messages change.
  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    (async () => {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id;
      if (!uid) return;
      channel = supabase
        .channel(`mesh-chat-${uid}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'chat_sessions', filter: `user_id=eq.${uid}` },
          () => qc.invalidateQueries({ queryKey: ['chat-sessions'] }),
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `user_id=eq.${uid}` },
          () => qc.invalidateQueries({ queryKey: ['chat-sessions'] }),
        )
        .subscribe();
    })();
    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [qc]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  const newChat = () => {
    setActiveSession(null);
    setMessages([]);
  };

  const sendFromPayload = (p: ChatInputPayload) => {
    // Compose final text from the chat input payload.
    // For now files/snippets are appended as plain text below the message;
    // a future iteration can upload + reference them as nodes.
    let text = p.message;
    if (p.pastedContent.length > 0) {
      text += '\n\n' + p.pastedContent.map((s) => `--- pasted ---\n${s.content}`).join('\n');
    }
    if (p.files.length > 0) {
      text += `\n\n[Attached ${p.files.length} file(s): ${p.files.map((f) => f.file.name).join(', ')}]`;
    }
    if (text.trim()) void send(text);
  };

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);

    const userMsg: UiMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      cited_nodes: [],
      created_at: new Date().toISOString(),
    };
    const assistantMsg: UiMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      cited_nodes: [],
      hits: [],
      created_at: new Date().toISOString(),
      streaming: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    // Intent: on-demand insights digest. We skip the chat stream entirely
    // and embed an InsightCard in the assistant bubble. The card carries its
    // own narrative so there's no need for separate prose.
    const insightDays = detectInsightIntent(text);
    if (insightDays !== null) {
      try {
        const res = await api.generateInsight(insightDays);
        const intro = res.insight
          ? `Here's your digest for the last ${insightDays} day${insightDays > 1 ? 's' : ''} — ${res.node_count} memories analyzed.`
          : `No memories captured in the last ${insightDays} day${insightDays > 1 ? 's' : ''} yet.`;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: intro,
                  insight: res.insight,
                  streaming: false,
                }
              : m,
          ),
        );
      } catch (e) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: `Could not generate insights: ${(e as Error).message}`,
                  streaming: false,
                }
              : m,
          ),
        );
      } finally {
        setBusy(false);
      }
      return;
    }

    try {
      for await (const ev of api.chatStream(activeSession, text)) {
        if (ev.type === 'meta') {
          if (!activeSession) setActiveSession(ev.session_id);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, hits: ev.hits, agent_used: ev.agent_used }
                : m,
            ),
          );
        } else if (ev.type === 'delta') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id ? { ...m, content: m.content + ev.text } : m,
            ),
          );
        } else if (ev.type === 'done') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, cited_nodes: ev.cited_nodes, streaming: false }
                : m,
            ),
          );
        }
      }
      qc.invalidateQueries({ queryKey: ['chat-sessions'] });
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                content: m.content + `\n\n[error] ${(e as Error).message}`,
                streaming: false,
              }
            : m,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const deleteSession = async (id: string) => {
    await api.deleteChatSession(id);
    if (id === activeSession) newChat();
    qc.invalidateQueries({ queryKey: ['chat-sessions'] });
  };

  const exportSession = async () => {
    if (!activeSession) return;
    const { session, messages: rows } = await api.loadChatSession(activeSession);
    const payload = {
      exported_at: new Date().toISOString(),
      session,
      messages: rows,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mesh-chat-${activeSession.slice(0, 8)}-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="relative flex h-full flex-col bg-neutral-950">
      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-8">
        {messages.length === 0 ? (
          <EmptyState onPick={send} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
          </div>
        )}
      </div>

      {/* Composer — no separator above */}
      <div className="bg-neutral-950 px-4 pb-6 pt-2">
        <ChatInput
          onSendMessage={sendFromPayload}
          disabled={busy}
          placeholder="Ask anything about your memory…"
        />
        <p className="mt-3 text-center text-[10px] text-neutral-600">
          Mesh uses your captured memories as context. Citations like [1] map to the sources panel.
        </p>
      </div>

      {/* Floating sessions panel */}
      <SessionsFloating
        sessions={sessions ?? []}
        activeSession={activeSession}
        onSelect={(id) => setActiveSession(id)}
        onNewChat={newChat}
        onDelete={deleteSession}
        onExport={exportSession}
        canExport={!!activeSession}
      />
    </div>
  );
}

/* ------------------------------------------------------------- */
/*                Floating sessions panel                         */
/* ------------------------------------------------------------- */

function SessionsFloating({
  sessions,
  activeSession,
  onSelect,
  onNewChat,
  onDelete,
  onExport,
  canExport,
}: {
  sessions: MockChatSession[];
  activeSession: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onExport: () => void;
  canExport: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* Trigger button — top-right */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="absolute right-4 top-4 z-30 flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/80 px-3 py-1.5 text-xs text-neutral-300 backdrop-blur-md transition-colors hover:border-neutral-700 hover:text-neutral-100"
        aria-label="Toggle conversations"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span>Chats</span>
        {sessions.length > 0 && (
          <span className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-neutral-400">
            {sessions.length}
          </span>
        )}
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="absolute inset-0 z-20 bg-black/30 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Floating panel */}
      <div
        className={`absolute right-4 top-16 z-30 w-72 origin-top-right transition-all duration-150 ${
          open
            ? 'pointer-events-auto scale-100 opacity-100'
            : 'pointer-events-none scale-95 opacity-0'
        }`}
      >
        <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/95 shadow-2xl backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-neutral-900 p-3">
            <span className="text-xs uppercase tracking-widest text-neutral-500">History</span>
            <button
              onClick={() => {
                onNewChat();
                setOpen(false);
              }}
              className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-semibold text-white hover:bg-accent-600"
            >
              <span className="text-sm leading-none">＋</span>
              <span>New</span>
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto p-1.5">
            {sessions.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-neutral-500">
                No conversations yet.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {sessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={s.id === activeSession}
                    onClick={() => {
                      onSelect(s.id);
                      setOpen(false);
                    }}
                    onDelete={() => onDelete(s.id)}
                  />
                ))}
              </ul>
            )}
          </div>

          {canExport && (
            <div className="border-t border-neutral-900 p-2">
              <button
                onClick={() => {
                  onExport();
                  setOpen(false);
                }}
                className="w-full rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
              >
                Export current as JSON
              </button>
            </div>
          )}

        </div>
      </div>
    </>
  );
}

function uiMessageFromDb(r: MockChatMessage): UiMessage {
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    cited_nodes: r.cited_nodes,
    created_at: r.created_at,
  };
}

function SessionRow({
  session,
  active,
  onClick,
  onDelete,
}: {
  session: MockChatSession;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      onClick={onClick}
      className={`group flex cursor-pointer items-center justify-between rounded-md px-2 py-2 text-sm ${
        active ? 'bg-neutral-900 text-white' : 'text-neutral-400 hover:bg-neutral-900/60'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate">{session.title}</div>
        <div className="text-[10px] text-neutral-500">
          {formatDistanceToNow(new Date(session.updated_at), { addSuffix: true })}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="opacity-0 group-hover:opacity-100"
        title="Delete"
      >
        <span className="text-neutral-500 hover:text-red-400">×</span>
      </button>
    </li>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 py-16 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-accent to-accent-700 text-2xl">
        🧠
      </div>
      <div>
        <h2 className="text-2xl font-semibold">Ask your memory anything</h2>
        <p className="mt-2 text-sm text-neutral-400">
          Mesh searches every memory you've captured and answers with citations.
        </p>
      </div>
      <div className="grid w-full gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-md border border-neutral-800 bg-neutral-900/40 px-4 py-3 text-left text-sm text-neutral-300 hover:border-neutral-700 hover:bg-neutral-900"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- */
/*           Render assistant prose with [N] → cite badges        */
/* ------------------------------------------------------------- */

const CITE_RE = /\[(\d{1,3})\](?:\s*\[(\d{1,3})\])*/g;

function CitedContent({ content, hits }: { content: string; hits: ChatHit[] }) {
  const [openHit, setOpenHit] = useState<ChatHit | null>(null);
  const hitByIndex = useMemo(() => {
    const m = new Map<number, ChatHit>();
    for (const h of hits) m.set(h.index, h);
    return m;
  }, [hits]);

  // Walk the content, splitting on [N] runs. Inside a run, every [N]
  // becomes its own badge.
  const parts: Array<{ kind: 'text'; value: string } | { kind: 'cite'; n: number }> = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  // Reset state on every render to keep parsing deterministic.
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(content))) {
    if (m.index > cursor) {
      parts.push({ kind: 'text', value: content.slice(cursor, m.index) });
    }
    // Pull every [\d+] inside this match
    const runRe = /\[(\d{1,3})\]/g;
    let inner: RegExpExecArray | null;
    while ((inner = runRe.exec(m[0]))) {
      const n = parseInt(inner[1]!, 10);
      parts.push({ kind: 'cite', n });
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < content.length) {
    parts.push({ kind: 'text', value: content.slice(cursor) });
  }

  return (
    <>
      <span className="whitespace-pre-wrap">
        {parts.map((p, i) => {
          if (p.kind === 'text') return <span key={i}>{p.value}</span>;
          const hit = hitByIndex.get(p.n);
          return (
            <button
              key={i}
              type="button"
              onClick={() => hit && setOpenHit(hit)}
              disabled={!hit}
              className={`mx-0.5 inline-flex items-center justify-center rounded-full border px-1.5 text-[10px] font-semibold align-text-bottom leading-none h-[18px] min-w-[18px] transition-colors ${
                hit
                  ? 'border-accent/40 bg-accent/15 text-accent hover:bg-accent/25 cursor-pointer'
                  : 'border-neutral-800 bg-neutral-900 text-neutral-500 cursor-default'
              }`}
              title={hit ? `Open source ${p.n}` : `Source ${p.n} not available`}
            >
              {p.n}
            </button>
          );
        })}
      </span>
      {openHit && <SourceModal hit={openHit} onClose={() => setOpenHit(null)} />}
    </>
  );
}

function SourceModal({ hit, onClose }: { hit: ChatHit; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-neutral-900 px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-full border border-accent/40 bg-accent/15 text-[10px] font-semibold text-accent">
              {hit.index}
            </span>
            <h3 className="text-sm font-semibold text-neutral-100">Source</h3>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-200"
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          <p className="whitespace-pre-line text-[14px] leading-relaxed text-neutral-200">
            {hit.summary}
          </p>
          <div className="mt-4 border-t border-neutral-900 pt-3 text-[11px] text-neutral-500">
            <div className="font-medium text-neutral-400">{hit.source}</div>
            {hit.source_url && (
              <a
                href={hit.source_url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block break-all text-accent hover:underline"
              >
                ↗ {hit.source_url}
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: UiMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="max-w-xl rounded-2xl rounded-br-md bg-neutral-800 px-4 py-2.5 text-sm text-neutral-100">
          {msg.content}
        </div>
        {msg.content && (
          <MessageActions content={msg.content} align="end" />
        )}
      </div>
    );
  }

  // Assistant: no bubble — plain text in the conversation flow, like Claude.
  return (
    <div className="group flex justify-start">
      <div className="min-w-0 max-w-2xl flex-1 space-y-3">
        <div className="flex items-start gap-3">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-accent-700 text-xs">
            🧠
          </div>
          <div className="min-w-0 flex-1 space-y-2 pt-0.5">
            {msg.agent_used && <AgentBadge agent={msg.agent_used} />}
            <div className="text-[15px] leading-relaxed text-neutral-100">
              <CitedContent content={msg.content} hits={msg.hits ?? []} />
              {msg.streaming && (
                <span className="ml-1 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-neutral-400 align-middle" />
              )}
            </div>
            {!msg.streaming && msg.content && (
              <MessageActions content={msg.content} align="start" assistant />
            )}
          </div>
        </div>
        {msg.insight && <InsightCard insight={msg.insight} />}
        {msg.hits && msg.hits.length > 0 && <Sources hits={msg.hits} />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- */
/*                  On-demand insight card                        */
/* ------------------------------------------------------------- */

const INSIGHT_TYPE_COLORS: Record<string, string> = {
  text: '#60a5fa',
  image: '#f472b6',
  video: '#fb923c',
  link: '#22d3ee',
  code: '#a78bfa',
  quote: '#facc15',
  page: '#34d399',
  action: '#e879f9',
};

function InsightCard({ insight }: { insight: InsightPayload }) {
  const [open, setOpen] = useState(true);
  const windowLabel =
    insight.window_days === 7
      ? 'this week'
      : insight.window_days === 30
        ? 'this month'
        : `last ${insight.window_days} days`;

  return (
    <article className="ml-10 overflow-hidden rounded-xl border border-accent/30 bg-gradient-to-br from-accent/5 to-neutral-950">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/5"
      >
        <div className="flex items-center gap-3">
          <span className="text-lg">✨</span>
          <div>
            <div className="text-sm font-medium text-neutral-100">
              Insights — {windowLabel}
            </div>
            <div className="text-[11px] text-neutral-500">
              {insight.node_count} memories ·{' '}
              {formatDistanceToNow(new Date(insight.generated_at), { addSuffix: true })}
            </div>
          </div>
        </div>
        <span className="text-xs text-neutral-500">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-accent/20 p-4">
          {insight.narrative && (
            <p className="whitespace-pre-line text-[13px] leading-relaxed text-neutral-200">
              {insight.narrative}
            </p>
          )}

          {insight.type_breakdown.length > 0 && (
            <InsightBlock title="Capture mix">
              <InsightTypeBar items={insight.type_breakdown} />
            </InsightBlock>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {insight.themes.length > 0 && (
              <InsightBlock title="Top themes">
                <InsightList items={insight.themes} />
              </InsightBlock>
            )}
            {insight.people.length > 0 && (
              <InsightBlock title="Key people">
                <InsightList items={insight.people} />
              </InsightBlock>
            )}
            {insight.top_authors.length > 0 && (
              <InsightBlock title="Authors you read">
                <InsightList items={insight.top_authors} />
              </InsightBlock>
            )}
            {insight.top_sites.length > 0 && (
              <InsightBlock title="Where attention went">
                <InsightList items={insight.top_sites} />
              </InsightBlock>
            )}
            {insight.top_keywords.length > 0 && (
              <InsightBlock title="Top keywords">
                <div className="flex flex-wrap gap-1">
                  {insight.top_keywords.map((k) => (
                    <span
                      key={k.label}
                      className="rounded-full border border-neutral-800 bg-neutral-900/60 px-2 py-0.5 text-[11px] text-neutral-300"
                    >
                      {k.label}
                      <span className="ml-1 text-neutral-500">{k.count}</span>
                    </span>
                  ))}
                </div>
              </InsightBlock>
            )}
            {insight.decisions.length > 0 && (
              <InsightBlock title="Decisions made">
                <ul className="space-y-1.5 text-[12px] text-neutral-300">
                  {insight.decisions.map((d, i) => (
                    <li key={i}>· {d.text}</li>
                  ))}
                </ul>
              </InsightBlock>
            )}
            {insight.expiring.length > 0 && (
              <InsightBlock title="Expiring soon">
                <p className="text-[12px] text-neutral-400">
                  {insight.expiring.length} memories will auto-delete this week.
                </p>
              </InsightBlock>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function InsightBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
      <h4 className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
        {title}
      </h4>
      {children}
    </div>
  );
}

function InsightList({ items }: { items: InsightCount[] }) {
  return (
    <ul className="space-y-1 text-[12px]">
      {items.map((t) => (
        <li key={t.label} className="flex justify-between text-neutral-300">
          <span className="truncate" title={t.label}>
            {t.label}
          </span>
          <span className="text-neutral-500">{t.count}</span>
        </li>
      ))}
    </ul>
  );
}

function InsightTypeBar({ items }: { items: InsightCount[] }) {
  const total = items.reduce((s, i) => s + i.count, 0);
  if (total === 0) return null;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full">
        {items.map((i) => (
          <span
            key={i.label}
            title={`${i.label}: ${i.count}`}
            style={{
              width: `${(i.count / total) * 100}%`,
              background: INSIGHT_TYPE_COLORS[i.label] ?? '#525252',
            }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-neutral-400">
        {items.map((i) => (
          <span key={i.label} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: INSIGHT_TYPE_COLORS[i.label] ?? '#525252' }}
            />
            {i.label}
            <span className="text-neutral-500">{i.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- */
/*                      Message action bar                        */
/* ------------------------------------------------------------- */

function MessageActions({
  content,
  align,
  assistant,
}: {
  content: string;
  align: 'start' | 'end';
  assistant?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className={`flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 ${
        align === 'end' ? 'justify-end' : 'justify-start'
      } ${assistant ? '' : 'mr-1'}`}
    >
      <ActionButton onClick={copy} title={copied ? 'Copied!' : 'Copy'} active={copied}>
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </ActionButton>

      {assistant && (
        <>
          <ActionButton
            onClick={() => setFeedback(feedback === 'up' ? null : 'up')}
            title="Good response"
            active={feedback === 'up'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={feedback === 'up' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
            </svg>
          </ActionButton>
          <ActionButton
            onClick={() => setFeedback(feedback === 'down' ? null : 'down')}
            title="Bad response"
            active={feedback === 'down'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={feedback === 'down' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
            </svg>
          </ActionButton>
        </>
      )}
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`rounded-md p-1.5 transition-colors ${
        active
          ? 'text-accent'
          : 'text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200'
      }`}
    >
      {children}
    </button>
  );
}

function AgentBadge({ agent }: { agent: AgentUsed }) {
  const meta: Record<AgentUsed, { label: string; icon: string }> = {
    daily_briefing: { label: 'Daily briefing', icon: '☀️' },
    follow_up: { label: 'Follow-up scan', icon: '🔁' },
    meeting_prep: { label: 'Meeting prep', icon: '📋' },
  };
  const m = meta[agent];
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent">
      <span>{m.icon}</span>
      <span>Used: {m.label}</span>
    </div>
  );
}

function Sources({ hits }: { hits: ChatHit[] }) {
  return (
    <details className="ml-10 rounded-md border border-neutral-800 bg-neutral-950/50 text-xs">
      <summary className="cursor-pointer px-3 py-1.5 text-neutral-400 hover:text-neutral-200">
        Sources ({hits.length})
      </summary>
      <ul className="space-y-1.5 border-t border-neutral-900 p-3">
        {hits.map((h) => (
          <li key={h.id} className="flex gap-2">
            <span className="shrink-0 text-neutral-500">[{h.index}]</span>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-neutral-300">{h.summary}</p>
              <p className="mt-0.5 text-[10px] text-neutral-500">
                {h.source}
                {h.source_url && (
                  <>
                    {' · '}
                    <a
                      href={h.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:text-neutral-300"
                    >
                      open
                    </a>
                  </>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
