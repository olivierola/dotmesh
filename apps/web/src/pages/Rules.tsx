/**
 * Two-section page:
 *
 *   1. Blocked sites — the extension refuses to capture / inject on any
 *      domain listed here. Combined with the hardcoded category list
 *      (banks, mail, healthcare, gov, password managers, etc.) inside
 *      the extension itself. Stored as rule_type='domain_block'.
 *
 *   2. Context rules — fine-grained ACLs over what each agent can
 *      access from your memory (existing feature).
 */

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

const SUGGESTED_BLOCKS = [
  { value: 'linkedin.com', label: 'LinkedIn' },
  { value: 'twitter.com', label: 'Twitter' },
  { value: 'x.com', label: 'X' },
  { value: 'reddit.com', label: 'Reddit' },
  { value: 'youtube.com', label: 'YouTube' },
  { value: 'github.com', label: 'GitHub' },
  { value: 'facebook.com', label: 'Facebook' },
  { value: 'instagram.com', label: 'Instagram' },
  { value: 'tiktok.com', label: 'TikTok' },
  { value: 'amazon.com', label: 'Amazon' },
];

export default function RulesPage() {
  const qc = useQueryClient();
  const { data: rules, isLoading } = useQuery({
    queryKey: ['rules'],
    queryFn: () => api.listRules(),
  });

  const blockedRules = (rules ?? []).filter((r) => r.rule_type === 'domain_block');
  const aclRules = (rules ?? []).filter((r) => r.rule_type !== 'domain_block');

  return (
    <div className="mx-auto max-w-3xl space-y-10 p-4 md:p-8">
      <header>
        <h1 className="text-2xl font-semibold">Privacy &amp; Rules</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Decide where Mesh is allowed to run, and what your AI agents can see.
        </p>
      </header>

      <BlockedSitesSection
        loading={isLoading}
        rules={blockedRules}
        onChange={() => qc.invalidateQueries({ queryKey: ['rules'] })}
      />

      <ContextRulesSection
        loading={isLoading}
        rules={aclRules}
        onChange={() => qc.invalidateQueries({ queryKey: ['rules'] })}
      />
    </div>
  );
}

/* --------------------------------------------------------------- */
/*                        Blocked sites                              */
/* --------------------------------------------------------------- */

type Rule = Awaited<ReturnType<typeof api.listRules>>[number];

function BlockedSitesSection({
  loading,
  rules,
  onChange,
}: {
  loading: boolean;
  rules: Rule[];
  onChange: () => void;
}) {
  const [domain, setDomain] = useState('');

  const add = useMutation({
    mutationFn: (value: string) =>
      api.createRule({
        rule_type: 'domain_block',
        target: value,
        action: 'deny',
        filter: {},
        priority: 100,
        enabled: true,
      }),
    onSuccess: () => {
      setDomain('');
      onChange();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRule(id),
    onSuccess: onChange,
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.toggleRule(id, enabled),
    onSuccess: onChange,
  });

  const normalize = (v: string) =>
    v.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();

  const handleAdd = () => {
    const clean = normalize(domain);
    if (!clean) return;
    if (rules.some((r) => r.target.toLowerCase() === clean)) return;
    add.mutate(clean);
  };

  const addSuggested = (value: string) => {
    if (rules.some((r) => r.target.toLowerCase() === value)) return;
    add.mutate(value);
  };

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6">
      <div className="mb-5">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-300">
          🚫 Blocked sites
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          The extension will not capture, inject context, or surface any UI on
          these domains. Sensitive categories (banking, mail, healthcare,
          government, password managers, crypto wallets, private messaging) are
          already blocked by default — add the ones specific to you below.
        </p>
      </div>

      <div className="mb-4 flex gap-2">
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          placeholder="e.g. linkedin.com or my-bank.example"
          className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm placeholder-neutral-600 focus:border-accent focus:outline-none"
        />
        <button
          onClick={handleAdd}
          disabled={add.isPending || !domain.trim()}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-accent-600 disabled:opacity-50"
        >
          Block
        </button>
      </div>

      <div className="mb-5">
        <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
          Quick add
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SUGGESTED_BLOCKS.filter(
            (s) => !rules.some((r) => r.target.toLowerCase() === s.value),
          ).map((s) => (
            <button
              key={s.value}
              onClick={() => addSuggested(s.value)}
              className="rounded-full border border-neutral-800 px-2.5 py-1 text-[11px] text-neutral-300 transition-colors hover:border-accent hover:text-accent"
            >
              + {s.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <SkeletonList count={2} />}
      {!loading && rules.length === 0 && (
        <p className="rounded-md border border-dashed border-neutral-800 p-4 text-center text-xs text-neutral-500">
          No custom blocks yet — the default sensitive list is still active.
        </p>
      )}

      {rules.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rules.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950/50 p-3 text-sm"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    r.enabled ? 'bg-red-400' : 'bg-neutral-600'
                  }`}
                />
                <span className="font-mono text-neutral-200">{r.target}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <button
                  onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}
                  className={`rounded border px-2 py-1 ${
                    r.enabled
                      ? 'border-red-900 text-red-300'
                      : 'border-neutral-800 text-neutral-500'
                  }`}
                >
                  {r.enabled ? 'blocked' : 'paused'}
                </button>
                <button
                  onClick={() => remove.mutate(r.id)}
                  className="rounded border border-neutral-800 px-2 py-1 text-neutral-500 hover:border-red-900 hover:text-red-400"
                >
                  remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- */
/*                      Context ACL rules                            */
/* --------------------------------------------------------------- */

function ContextRulesSection({
  loading,
  rules,
  onChange,
}: {
  loading: boolean;
  rules: Rule[];
  onChange: () => void;
}) {
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
      onChange();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteRule(id),
    onSuccess: onChange,
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.toggleRule(id, enabled),
    onSuccess: onChange,
  });

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6">
      <div className="mb-5">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-300">
          🛡 Context rules
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Restrict what each AI agent can read from your memory. By default,
          every agent sees everything.
        </p>
      </div>

      <div className="mb-5 grid gap-3 rounded-md border border-neutral-800 bg-neutral-950/50 p-4 sm:grid-cols-3">
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
        <button
          onClick={() => add.mutate()}
          disabled={add.isPending}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-accent-600 disabled:opacity-50 sm:col-span-3"
        >
          Add rule
        </button>
      </div>

      {loading && <SkeletonList count={3} />}
      {!loading && rules.length === 0 && (
        <p className="rounded-md border border-dashed border-neutral-800 p-4 text-center text-xs text-neutral-500">
          No context rules yet. Every agent sees everything.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {rules.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-950/50 p-4 text-sm"
          >
            <div>
              <div className="font-medium text-neutral-100">
                {r.action.toUpperCase()} on{' '}
                <span className="text-accent">{r.target}</span>
                {r.filter.tags?.length ? (
                  <span className="text-neutral-400">
                    {' '}
                    · tags: {r.filter.tags.join(', ')}
                  </span>
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
  );
}
