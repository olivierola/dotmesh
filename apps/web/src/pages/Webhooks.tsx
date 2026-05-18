import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { supabase } from '@/lib/supabase';
import { SkeletonList } from '@/components/Skeleton';

interface Webhook {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  active: boolean;
  last_delivered_at: string | null;
  last_status: number | null;
  failure_count: number;
  created_at: string;
}

const API_BASE =
  (import.meta.env.VITE_API_URL as string) ??
  `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1`;

const EVENT_OPTIONS = [
  { value: '*', label: 'All events' },
  { value: 'node.created', label: 'Memory created' },
  { value: 'node.deleted', label: 'Memory deleted' },
  { value: 'injection', label: 'Injection happened' },
];

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.session?.access_token ?? ''}`,
  };
}

async function listWebhooks(): Promise<Webhook[]> {
  const res = await fetch(`${API_BASE}/webhooks`, { headers: await authHeaders() });
  if (!res.ok) throw new Error(`list_failed:${res.status}`);
  const { webhooks } = (await res.json()) as { webhooks: Webhook[] };
  return webhooks;
}

async function createWebhook(input: {
  url: string;
  events: string[];
  description?: string;
}): Promise<{ webhook: Webhook; secret: string }> {
  const res = await fetch(`${API_BASE}/webhooks`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create_failed:${res.status}`);
  return res.json();
}

async function deleteWebhook(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/webhooks/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`delete_failed:${res.status}`);
}

async function toggleWebhook(id: string, active: boolean): Promise<void> {
  const res = await fetch(`${API_BASE}/webhooks/${id}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify({ active }),
  });
  if (!res.ok) throw new Error(`update_failed:${res.status}`);
}

async function pingWebhook(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/webhooks/${id}/test`, {
    method: 'POST',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`ping_failed:${res.status}`);
}

export default function WebhooksPage() {
  const qc = useQueryClient();
  const { data: hooks, isLoading } = useQuery({ queryKey: ['webhooks'], queryFn: listWebhooks });

  const [form, setForm] = useState({ url: '', events: ['*'], description: '' });
  const [revealedSecret, setRevealedSecret] = useState<{ id: string; secret: string } | null>(
    null,
  );

  const create = useMutation({
    mutationFn: createWebhook,
    onSuccess: (data) => {
      setRevealedSecret({ id: data.webhook.id, secret: data.secret });
      setForm({ url: '', events: ['*'], description: '' });
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });

  const remove = useMutation({
    mutationFn: deleteWebhook,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => toggleWebhook(id, active),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  const ping = useMutation({ mutationFn: pingWebhook });

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-semibold">Webhooks</h1>
      <p className="mb-6 text-sm text-neutral-400">
        Receive HTTP notifications when something happens in your Mesh. Each delivery is signed
        with HMAC-SHA256.
      </p>

      <section className="mb-8 rounded-md border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-400">
          Create a webhook
        </h2>
        <div className="space-y-3">
          <input
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://your-endpoint.example.com/mesh"
            className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm placeholder-neutral-600 focus:border-accent focus:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            {EVENT_OPTIONS.map((opt) => {
              const checked = form.events.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    if (opt.value === '*') {
                      setForm({ ...form, events: ['*'] });
                      return;
                    }
                    const next = checked
                      ? form.events.filter((e) => e !== opt.value)
                      : [...form.events.filter((e) => e !== '*'), opt.value];
                    setForm({ ...form, events: next.length ? next : ['*'] });
                  }}
                  className={`rounded-full border px-3 py-1 text-xs ${
                    checked
                      ? 'border-accent bg-accent/15 text-accent'
                      : 'border-neutral-700 text-neutral-400 hover:border-neutral-600'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Description (optional)"
            className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm placeholder-neutral-600 focus:border-accent focus:outline-none"
          />
          <button
            onClick={() => create.mutate({ ...form, description: form.description || undefined })}
            disabled={!form.url || create.isPending}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create webhook'}
          </button>
        </div>
      </section>

      {revealedSecret && (
        <div className="mb-8 rounded-md border border-amber-700 bg-amber-950/30 p-4 text-sm">
          <div className="mb-2 font-medium text-amber-300">
            🔐 Copy this secret now. It will never be shown again.
          </div>
          <code className="block break-all rounded bg-neutral-950 p-2 font-mono text-xs text-neutral-200">
            {revealedSecret.secret}
          </code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(revealedSecret.secret);
              setRevealedSecret(null);
            }}
            className="mt-3 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:border-neutral-600"
          >
            Copy & dismiss
          </button>
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-400">
          Active webhooks
        </h2>
        {isLoading && <SkeletonList count={3} />}
        {hooks?.length === 0 && (
          <p className="text-sm text-neutral-500">No webhooks yet.</p>
        )}
        <ul className="flex flex-col gap-2">
          {hooks?.map((h) => (
            <li
              key={h.id}
              className="rounded-md border border-neutral-800 bg-neutral-900 p-4 text-sm"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${h.active ? 'bg-emerald-400' : 'bg-neutral-600'}`}
                    />
                    <code className="truncate font-mono text-xs text-neutral-200">{h.url}</code>
                  </div>
                  {h.description && (
                    <p className="mt-1 text-xs text-neutral-500">{h.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {h.events.map((e) => (
                      <span
                        key={e}
                        className="rounded-full border border-neutral-700 px-2 py-0.5 text-[10px] text-neutral-400"
                      >
                        {e}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 text-[11px] text-neutral-500">
                    {h.last_delivered_at
                      ? `Last delivered ${formatDistanceToNow(new Date(h.last_delivered_at), { addSuffix: true })} · status ${h.last_status}`
                      : 'No deliveries yet.'}
                    {h.failure_count > 0 && (
                      <span className="ml-2 text-red-400">{h.failure_count} failures</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => ping.mutate(h.id)}
                    className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-200 hover:border-neutral-600"
                  >
                    Ping
                  </button>
                  <button
                    onClick={() => toggle.mutate({ id: h.id, active: !h.active })}
                    className={`rounded border px-2 py-1 text-xs ${
                      h.active
                        ? 'border-emerald-700 text-emerald-400'
                        : 'border-neutral-700 text-neutral-500'
                    }`}
                  >
                    {h.active ? 'on' : 'off'}
                  </button>
                  <button
                    onClick={() => remove.mutate(h.id)}
                    className="rounded border border-red-900 px-2 py-1 text-xs text-red-400 hover:bg-red-950"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10 rounded-md border border-neutral-800 bg-neutral-900/40 p-5 text-xs text-neutral-400">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-widest text-neutral-500">
          Signature verification
        </h3>
        <p className="mb-2">Each request includes a <code>Mesh-Signature</code> header:</p>
        <pre className="overflow-x-auto rounded bg-neutral-950 p-3 text-[11px] text-neutral-300">
{`Mesh-Signature: t=1715900000,v1=hex(hmac_sha256(secret, "<t>." + body))`}
        </pre>
        <p className="mt-2">Verify by recomputing v1 and comparing constant-time.</p>
      </section>
    </div>
  );
}
