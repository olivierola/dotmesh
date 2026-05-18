import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { SkeletonList } from '@/components/Skeleton';

const AGENT_PRESETS = [
  { value: 'claude.ai', label: 'Claude' },
  { value: 'chatgpt.com', label: 'ChatGPT' },
  { value: 'gemini.google.com', label: 'Gemini' },
  { value: 'www.perplexity.ai', label: 'Perplexity' },
  { value: '*', label: 'All agents' },
];

export default function RulesPage() {
  const qc = useQueryClient();
  const { data: rules, isLoading } = useQuery({
    queryKey: ['rules'],
    queryFn: () => api.listRules(),
  });

  const [form, setForm] = useState({
    target: 'chatgpt.com',
    action: 'deny' as 'allow' | 'deny' | 'redact',
    tags: '',
  });

  const add = useMutation({
    mutationFn: () =>
      api.createRule({
        rule_type: 'agent_acl',
        target: form.target,
        action: form.action,
        filter: {
          tags: form.tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        },
        priority: 100,
        enabled: true,
      }),
    onSuccess: () => {
      setForm({ ...form, tags: '' });
      qc.invalidateQueries({ queryKey: ['rules'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.toggleRule(id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 className="mb-6 text-2xl font-semibold">Context Rules</h1>

      <section className="mb-8 rounded-md border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-400">
          New rule
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <select
            value={form.target}
            onChange={(e) => setForm({ ...form, target: e.target.value })}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
          >
            {AGENT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <select
            value={form.action}
            onChange={(e) =>
              setForm({ ...form, action: e.target.value as 'allow' | 'deny' | 'redact' })
            }
            className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
          >
            <option value="deny">Block</option>
            <option value="allow">Allow only</option>
            <option value="redact">Redact</option>
          </select>
          <input
            placeholder="tags, comma-separated"
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm placeholder-neutral-600"
          />
        </div>
        <button
          onClick={() => add.mutate()}
          disabled={add.isPending}
          className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
        >
          Add rule
        </button>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-400">
          Active rules
        </h2>
        {isLoading && <SkeletonList count={3} />}
        {rules?.length === 0 && (
          <p className="text-sm text-neutral-500">No rules yet. All agents see everything.</p>
        )}
        <ul className="flex flex-col gap-2">
          {rules?.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900 p-4 text-sm"
            >
              <div>
                <div className="font-medium text-neutral-100">
                  {r.action.toUpperCase()} on <span className="text-accent">{r.target}</span>
                  {r.filter.tags?.length ? (
                    <span className="text-neutral-400"> · tags: {r.filter.tags.join(', ')}</span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  type: {r.rule_type} · priority {r.priority}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}
                  className={`rounded border px-2 py-1 text-xs ${
                    r.enabled
                      ? 'border-emerald-700 text-emerald-400'
                      : 'border-neutral-700 text-neutral-500'
                  }`}
                >
                  {r.enabled ? 'enabled' : 'disabled'}
                </button>
                <button
                  onClick={() => remove.mutate(r.id)}
                  className="rounded border border-red-900 px-2 py-1 text-xs text-red-400 hover:bg-red-950"
                >
                  delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
