import { useEffect, useRef, useState } from 'react';

const API_BASE =
  (import.meta.env.VITE_API_URL as string) ??
  `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1`;

/**
 * Public embed widget. Loaded inside an iframe on a third-party site.
 * Auth via ?token=… query param, validated server-side per request.
 *
 * No AppShell, no auth check — fully standalone.
 */
export default function EmbedAskPage() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token') ?? '';
  const placeholder = url.searchParams.get('placeholder') ?? 'Ask anything…';
  const accent = url.searchParams.get('accent') ?? '#f5b301';

  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [answer]);

  const ask = async () => {
    if (!q.trim() || busy) return;
    if (!token) {
      setError('Missing ?token= in iframe URL');
      return;
    }
    setBusy(true);
    setAnswer('');
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/embed-ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ question: q }),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(`${res.status}: ${detail || 'request failed'}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setAnswer(acc);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex h-screen flex-col bg-neutral-950 text-neutral-100"
      style={{ ['--accent' as string]: accent }}
    >
      <header className="flex items-center justify-between border-b border-neutral-900 px-4 py-2.5">
        <div className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
          🧠 <span>Ask Mesh</span>
        </div>
        <a
          href="https://mesh.so"
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-neutral-500 hover:text-neutral-300"
        >
          Powered by Mesh
        </a>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 text-sm">
        {!answer && !busy && !error && (
          <div className="grid h-full place-items-center text-center text-xs text-neutral-500">
            <div>
              <p>Type a question below.</p>
              <p className="mt-1">Answers come from this user's private memory.</p>
            </div>
          </div>
        )}
        {error && (
          <div className="rounded-md border border-red-900 bg-red-950/30 p-3 text-xs text-red-400">
            {error}
          </div>
        )}
        {answer && (
          <div className="whitespace-pre-wrap leading-relaxed text-neutral-200">
            {answer}
            {busy && <span className="ml-1 inline-block animate-pulse">▋</span>}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
        className="flex items-end gap-2 border-t border-neutral-900 p-3"
      >
        <textarea
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
          rows={1}
          placeholder={placeholder}
          className="flex-1 resize-none rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm placeholder-neutral-600 focus:border-[var(--accent)] focus:outline-none"
          style={{ minHeight: 38, maxHeight: 140 }}
        />
        <button
          type="submit"
          disabled={busy || !q.trim()}
          className="rounded-md px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
          style={{ background: accent }}
        >
          {busy ? '…' : 'Ask'}
        </button>
      </form>
    </div>
  );
}
