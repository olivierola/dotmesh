import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { supabase } from '@/lib/supabase';
import { SkeletonList } from '@/components/Skeleton';
import { api } from '@/lib/api-client';

const API_BASE =
  (import.meta.env.VITE_API_URL as string) ??
  `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1`;
const WEB_BASE = window.location.origin;

interface Token {
  id: string;
  name: string;
  token_prefix: string;
  allowed_origins: string[];
  rate_limit_per_minute: number;
  scopes: string[];
  collection_ids: string[];
  active: boolean;
  last_used_at: string | null;
  call_count: number;
  created_at: string;
}

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.session?.access_token ?? ''}`,
  };
}

async function listTokens(): Promise<Token[]> {
  const res = await fetch(`${API_BASE}/embed-tokens`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`list_failed:${res.status}`);
  const { tokens } = (await res.json()) as { tokens: Token[] };
  return tokens;
}

async function createToken(input: {
  name: string;
  allowed_origins: string[];
  rate_limit_per_minute: number;
  collection_ids?: string[];
}): Promise<{ token: Token; plaintext: string }> {
  const res = await fetch(`${API_BASE}/embed-tokens`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function deleteToken(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/embed-tokens/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`delete_failed:${res.status}`);
}

export default function EmbedSettingsPage() {
  const qc = useQueryClient();
  const { data: tokens, isLoading } = useQuery({
    queryKey: ['embed-tokens'],
    queryFn: listTokens,
  });
  const { data: collections } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.listCollections(),
  });
  const [form, setForm] = useState({
    name: '',
    origins: '',
    rate: 20,
    collection_ids: [] as string[],
  });
  const [revealed, setRevealed] = useState<{ id: string; plaintext: string } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      createToken({
        name: form.name,
        allowed_origins: form.origins
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
        rate_limit_per_minute: form.rate,
        collection_ids: form.collection_ids,
      }),
    onSuccess: ({ token, plaintext }) => {
      setRevealed({ id: token.id, plaintext });
      setForm({ name: '', origins: '', rate: 20, collection_ids: [] });
      qc.invalidateQueries({ queryKey: ['embed-tokens'] });
    },
  });

  const remove = useMutation({
    mutationFn: deleteToken,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['embed-tokens'] }),
  });

  const snippet = revealed
    ? `<iframe
  src="${WEB_BASE}/embed/ask?token=${revealed.plaintext}"
  width="380"
  height="540"
  frameborder="0"
  style="border:1px solid #262626;border-radius:12px;background:#0a0a0a;"
  allow="clipboard-write"
></iframe>`
    : '';

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-semibold">Embed Mesh on your site</h1>
      <p className="mb-6 text-sm text-neutral-400">
        Drop an "Ask my memory" widget into any website with a single iframe.
      </p>

      <section className="mb-8 rounded-md border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-400">
          Create a token
        </h2>
        <div className="space-y-3">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="My personal site"
            className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm placeholder-neutral-600 focus:border-accent focus:outline-none"
          />
          <textarea
            value={form.origins}
            onChange={(e) => setForm({ ...form, origins: e.target.value })}
            rows={3}
            placeholder={'https://your-site.com\nhttps://www.your-site.com'}
            className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs placeholder-neutral-600 focus:border-accent focus:outline-none"
          />
          <div className="flex items-center gap-3 text-xs text-neutral-400">
            Rate limit
            <input
              type="number"
              min={1}
              max={600}
              value={form.rate}
              onChange={(e) => setForm({ ...form, rate: parseInt(e.target.value || '20', 10) })}
              className="w-20 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm"
            />
            requests / minute
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-neutral-500">
              Collections (scope)
            </label>
            <p className="mb-2 text-[11px] text-neutral-500">
              Restrict what this token can read. Leave empty to allow all memories.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(collections ?? []).map((c) => {
                const checked = form.collection_ids.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() =>
                      setForm({
                        ...form,
                        collection_ids: checked
                          ? form.collection_ids.filter((id) => id !== c.id)
                          : [...form.collection_ids, c.id],
                      })
                    }
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                      checked
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'
                    }`}
                  >
                    <span>{c.icon ?? (c.is_default ? '📥' : '🗂')}</span>
                    <span>{c.name}</span>
                    <span className="text-neutral-500">·</span>
                    <span className="text-[10px] text-neutral-500">{c.node_count}</span>
                  </button>
                );
              })}
              {(collections ?? []).length === 0 && (
                <p className="text-xs text-neutral-500">
                  No collections yet. Create some on the Collections page first.
                </p>
              )}
            </div>
          </div>

          <button
            onClick={() => create.mutate()}
            disabled={!form.name || !form.origins || create.isPending}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create token'}
          </button>
        </div>
      </section>

      {revealed && (
        <section className="mb-8 rounded-md border border-amber-700 bg-amber-950/30 p-4 text-sm">
          <div className="mb-2 font-medium text-amber-300">
            🔐 Copy the token below — it won't be shown again.
          </div>
          <code className="block break-all rounded bg-neutral-950 p-2 font-mono text-xs text-neutral-200">
            {revealed.plaintext}
          </code>
          <p className="mt-3 mb-1 text-xs text-neutral-400">Paste this iframe into your site:</p>
          <pre className="overflow-x-auto rounded bg-neutral-950 p-3 font-mono text-[11px] text-neutral-300">
            {snippet}
          </pre>
          <button
            onClick={() => {
              navigator.clipboard.writeText(snippet);
            }}
            className="mt-3 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:border-neutral-600"
          >
            Copy snippet
          </button>
          <button
            onClick={() => setRevealed(null)}
            className="mt-3 ml-2 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300"
          >
            Done
          </button>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-400">
          Active tokens
        </h2>
        {isLoading && <SkeletonList count={2} />}
        {tokens?.length === 0 && (
          <p className="text-sm text-neutral-500">No embed tokens yet.</p>
        )}
        <ul className="space-y-2">
          {tokens?.map((t) => (
            <li
              key={t.id}
              className="rounded-md border border-neutral-800 bg-neutral-900 p-4 text-sm"
            >
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-neutral-100">{t.name}</div>
                  <code className="mt-1 block font-mono text-[11px] text-neutral-500">
                    {t.token_prefix}
                  </code>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.allowed_origins.map((o) => (
                      <span
                        key={o}
                        className="rounded-full border border-neutral-700 px-2 py-0.5 font-mono text-[10px] text-neutral-400"
                      >
                        {o}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 text-[11px] text-neutral-500">
                    {t.call_count} calls ·{' '}
                    {t.last_used_at
                      ? `last used ${formatDistanceToNow(new Date(t.last_used_at), { addSuffix: true })}`
                      : 'never used'}{' '}
                    · {t.rate_limit_per_minute}/min
                  </div>
                  {t.collection_ids.length > 0 && collections && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {t.collection_ids.map((cid) => {
                        const c = collections.find((x) => x.id === cid);
                        if (!c) return null;
                        return (
                          <span
                            key={cid}
                            className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/5 px-2 py-0.5 text-[10px] text-accent"
                          >
                            {c.icon ?? '🗂'} {c.name}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => remove.mutate(t.id)}
                  className="rounded border border-red-900 px-2 py-1 text-xs text-red-400 hover:bg-red-950"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
