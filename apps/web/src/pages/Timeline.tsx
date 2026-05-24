import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import type { MockNode } from '@/lib/mock';
import CaptureBar, { type CapturePayload } from '@/components/CaptureBar';
import { SkeletonList } from '@/components/Skeleton';
import { displayForNode } from '@/lib/node-display';

interface SessionGroup {
  /** session_id or 'older' for nodes with no session_id. */
  key: string;
  isUngrouped: boolean;
  startedAt: Date;
  endedAt: Date;
  /** Distinct site_name / source_app collected across the session. */
  sites: string[];
  /** Distinct node_type values to colour the row. */
  types: string[];
  nodes: MockNode[];
}

function sessionIdOf(n: MockNode): string | null {
  const md = n.metadata as Record<string, unknown> | undefined;
  const sid = md?.session_id;
  return typeof sid === 'string' && sid.length > 0 ? sid : null;
}

function siteOf(n: MockNode): string | null {
  return (
    n.metadata?.extracted?.site_name ??
    n.source_app ??
    (() => {
      try {
        return n.source_url ? new URL(n.source_url).hostname : null;
      } catch {
        return null;
      }
    })()
  );
}

/**
 * Group sorted-desc nodes into session buckets. Pinned nodes stay outside
 * a group and float to the top (handled by the caller).
 */
function groupBySession(nodesSortedDesc: MockNode[]): SessionGroup[] {
  const buckets = new Map<string, MockNode[]>();
  const order: string[] = [];
  for (const n of nodesSortedDesc) {
    const sid = sessionIdOf(n) ?? 'older';
    if (!buckets.has(sid)) {
      buckets.set(sid, []);
      order.push(sid);
    }
    buckets.get(sid)!.push(n);
  }
  const groups: SessionGroup[] = [];
  for (const key of order) {
    const arr = buckets.get(key)!;
    // arr is in desc order already (we kept the input order)
    const startedAt = new Date(arr[arr.length - 1]!.created_at);
    const endedAt = new Date(arr[0]!.created_at);
    const sites = Array.from(
      new Set(arr.map(siteOf).filter((s): s is string => !!s)),
    ).slice(0, 5);
    const types = Array.from(
      new Set(
        arr
          .map(
            (n): string =>
              (n.node_type as string | undefined) ??
              (n.metadata?.extracted?.node_type as string | undefined) ??
              'text',
          )
          .filter((t): t is string => !!t),
      ),
    );
    groups.push({
      key,
      isUngrouped: key === 'older',
      startedAt,
      endedAt,
      sites,
      types,
      nodes: arr,
    });
  }
  return groups;
}

const TYPE_DOT: Record<string, string> = {
  text: '#60a5fa',
  image: '#f472b6',
  video: '#fb923c',
  link: '#22d3ee',
  code: '#a78bfa',
  quote: '#facc15',
  page: '#34d399',
  action: '#e879f9',
};

export default function TimelinePage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['nodes'],
    queryFn: () => api.listNodes({ limit: 50 }),
  });

  const create = useMutation({
    mutationFn: (payload: CapturePayload) =>
      api.createNode({ ...payload, source: 'manual' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nodes'] }),
  });

  const removeOne = useMutation({
    mutationFn: (id: string) => api.deleteNode(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nodes'] }),
  });

  const removeMany = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await api.deleteNode(id);
    },
    onSuccess: () => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['nodes'] });
    },
  });

  const update = useMutation({
    mutationFn: (params: {
      id: string;
      patch: Parameters<typeof api.updateNode>[1];
    }) => api.updateNode(params.id, params.patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['nodes'] }),
  });

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!data) return;
    if (selected.size === data.nodes.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(data.nodes.map((n) => n.id)));
    }
  };

  const { pinned, groups } = useMemo(() => {
    if (!data) return { pinned: [] as MockNode[], groups: [] as SessionGroup[] };
    const sortedDesc = [...data.nodes].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    return {
      pinned: sortedDesc.filter((n) => n.pinned),
      groups: groupBySession(sortedDesc.filter((n) => !n.pinned)),
    };
  }, [data]);

  const selectedArr = Array.from(selected);
  const allSelected = !!data && data.nodes.length > 0 && selected.size === data.nodes.length;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 className="mb-6 text-2xl font-semibold">Memory Timeline</h1>

      <CaptureBar onSubmit={(p) => create.mutate(p)} pending={create.isPending} />

      {/* Selection toolbar */}
      {data && data.nodes.length > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs">
          <label className="flex cursor-pointer items-center gap-2 text-neutral-400">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="h-3 w-3 accent-accent"
            />
            {selected.size === 0
              ? 'Select all'
              : `${selected.size} selected${allSelected ? ' (all)' : ''}`}
          </label>
          {selected.size > 0 && (
            <div className="flex gap-2">
              <button
                onClick={() => setSelected(new Set())}
                className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:border-neutral-600"
              >
                Cancel
              </button>
              <button
                disabled={removeMany.isPending}
                onClick={() => {
                  if (confirm(`Delete ${selected.size} memories? This cannot be undone.`)) {
                    removeMany.mutate(selectedArr);
                  }
                }}
                className="rounded border border-red-900 bg-red-950/40 px-2 py-1 text-red-300 hover:bg-red-950 disabled:opacity-50"
              >
                {removeMany.isPending ? 'Deleting…' : `Delete ${selected.size}`}
              </button>
            </div>
          )}
        </div>
      )}

      {isLoading && <SkeletonList count={5} />}

      {/* Pinned memories float to the very top, outside session grouping. */}
      {pinned.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
            <span className="text-accent">★</span> Pinned
          </h2>
          <ul className="flex flex-col gap-2">
            {pinned.map((n) => (
              <NodeRow
                key={n.id}
                n={n}
                selected={selected.has(n.id)}
                editing={editingId === n.id}
                onToggle={() => toggle(n.id)}
                onStartEdit={() => setEditingId(n.id)}
                onSaveEdit={(text) => {
                  update.mutate({
                    id: n.id,
                    patch: { edited_summary: text, summary: text },
                  });
                  setEditingId(null);
                }}
                onCancelEdit={() => setEditingId(null)}
                onTogglePin={() =>
                  update.mutate({ id: n.id, patch: { pinned: !n.pinned } })
                }
                onDelete={() => removeOne.mutate(n.id)}
              />
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-col gap-5">
        {groups.map((g) => (
          <SessionBlock
            key={g.key}
            group={g}
            collapsed={collapsed.has(g.key)}
            onToggleCollapse={() => toggleGroup(g.key)}
            renderNode={(n) => (
              <NodeRow
                key={n.id}
                n={n}
                selected={selected.has(n.id)}
                editing={editingId === n.id}
                onToggle={() => toggle(n.id)}
                onStartEdit={() => setEditingId(n.id)}
                onSaveEdit={(text) => {
                  update.mutate({
                    id: n.id,
                    patch: { edited_summary: text, summary: text },
                  });
                  setEditingId(null);
                }}
                onCancelEdit={() => setEditingId(null)}
                onTogglePin={() =>
                  update.mutate({ id: n.id, patch: { pinned: !n.pinned } })
                }
                onDelete={() => removeOne.mutate(n.id)}
              />
            )}
          />
        ))}
        {data?.nodes.length === 0 && (
          <p className="text-sm text-neutral-500">No memories yet. Add one above.</p>
        )}
      </div>
    </div>
  );
}

function SessionBlock({
  group,
  collapsed,
  onToggleCollapse,
  renderNode,
}: {
  group: SessionGroup;
  collapsed: boolean;
  onToggleCollapse: () => void;
  renderNode: (n: MockNode) => JSX.Element;
}) {
  const minutes = Math.max(
    1,
    Math.round((group.endedAt.getTime() - group.startedAt.getTime()) / 60_000),
  );

  const headline = group.isUngrouped
    ? 'Older memories (no session)'
    : `Session · ${format(group.endedAt, 'MMM d, HH:mm')}`;

  return (
    <section>
      <header className="mb-2 flex items-center justify-between gap-2">
        <button
          onClick={onToggleCollapse}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="text-neutral-500 transition-transform" style={{
            display: 'inline-block',
            transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
          }}>▾</span>
          <h2 className="truncate text-sm font-medium text-neutral-200">
            {headline}
          </h2>
          <span className="text-[11px] text-neutral-500">
            {group.nodes.length} memor{group.nodes.length === 1 ? 'y' : 'ies'}
            {!group.isUngrouped && ` · ${minutes}m`}
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          {group.types.slice(0, 4).map((t) => (
            <span
              key={t}
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: TYPE_DOT[t] ?? '#737373' }}
              title={t}
            />
          ))}
          {group.sites.slice(0, 3).map((s) => (
            <span
              key={s}
              className="rounded-full border border-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400"
            >
              {s}
            </span>
          ))}
        </div>
      </header>
      {!collapsed && (
        <ul className="ml-2 flex flex-col gap-2 border-l border-neutral-800 pl-3">
          {group.nodes.map(renderNode)}
        </ul>
      )}
    </section>
  );
}

function NodeRow({
  n,
  selected,
  editing,
  onToggle,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onTogglePin,
  onDelete,
}: {
  n: MockNode;
  selected: boolean;
  editing: boolean;
  onToggle: () => void;
  onStartEdit: () => void;
  onSaveEdit: (text: string) => void;
  onCancelEdit: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const display = displayForNode(n);
  const [draft, setDraft] = useState(display.title);
  const [expanded, setExpanded] = useState(false);

  return (
    <li
      className={`flex gap-3 rounded-lg border p-3 text-sm transition-colors ${
        selected
          ? 'border-accent/60 bg-accent/5'
          : 'border-neutral-800 bg-neutral-900 hover:border-neutral-700'
      }`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="mt-1.5 h-3 w-3 shrink-0 accent-accent"
      />

      {/* Favicon / type icon */}
      <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 text-base">
        {display.faviconUrl ? (
          <img
            src={display.faviconUrl}
            alt=""
            className="h-5 w-5"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <span>{iconForNode(n)}</span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-200 focus:border-accent focus:outline-none"
            />
            <div className="flex justify-end gap-2 text-xs">
              <button
                onClick={onCancelEdit}
                className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:border-neutral-600"
              >
                Cancel
              </button>
              <button
                onClick={() => onSaveEdit(draft.trim())}
                disabled={!draft.trim()}
                className="rounded bg-accent px-2 py-1 font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <h3
                className="min-w-0 flex-1 truncate text-[14px] font-medium text-neutral-100"
                title={display.title}
              >
                {n.pinned && <span className="mr-1 text-accent">★</span>}
                {display.title}
              </h3>
              <div className="flex shrink-0 items-center gap-1 text-neutral-500">
                <button
                  onClick={onTogglePin}
                  className={`rounded p-1 transition-colors ${
                    n.pinned ? 'text-accent' : 'hover:text-accent'
                  }`}
                  title={n.pinned ? 'Unpin' : 'Pin'}
                >
                  ★
                </button>
                <button
                  onClick={() => {
                    setDraft(display.title);
                    onStartEdit();
                  }}
                  className="rounded p-1 hover:text-neutral-200"
                  title="Edit"
                >
                  ✎
                </button>
                <button
                  onClick={onDelete}
                  className="rounded p-1 hover:text-red-400"
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </div>

            {/* Media thumb for images/videos */}
            {n.metadata?.elementType === 'image' && n.metadata?.mediaUrl && (
              <div className="mt-2 overflow-hidden rounded border border-neutral-800 bg-neutral-950">
                <img
                  src={n.metadata.mediaUrl as string}
                  alt={display.title}
                  className="block h-auto max-h-48 w-full object-contain"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
            )}
            {n.metadata?.elementType === 'video' && n.metadata?.mediaUrl && (
              <div className="mt-2 overflow-hidden rounded border border-neutral-800 bg-neutral-950">
                <video
                  src={n.metadata.mediaUrl as string}
                  controls
                  preload="metadata"
                  className="block h-auto max-h-48 w-full"
                />
              </div>
            )}

            {display.body && (
              <p
                onClick={() => setExpanded((v) => !v)}
                className={`mt-1 cursor-pointer text-[13px] leading-relaxed text-neutral-400 ${
                  expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'
                }`}
                title={expanded ? 'Collapse' : 'Expand'}
              >
                {display.body}
              </p>
            )}

            {/* Footer: host · time · open link · badges */}
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500">
              {display.subtitle && (
                <span className="font-medium text-neutral-400">{display.subtitle}</span>
              )}
              <span>·</span>
              <span>{formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}</span>
              {n.metadata?.captureType && (
                <>
                  <span>·</span>
                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-300/80">
                    {String(n.metadata.captureType)}
                  </span>
                </>
              )}
              {n.source_url && (
                <a
                  href={n.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto rounded border border-neutral-800 px-2 py-0.5 text-neutral-400 hover:border-accent hover:text-accent"
                >
                  open ↗
                </a>
              )}
            </div>

            {n.entities.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {n.entities.slice(0, 5).map((e, i) => (
                  <span
                    key={i}
                    className="rounded-full bg-neutral-800/80 px-2 py-0.5 text-[10px] text-neutral-400"
                  >
                    {e.value}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function iconForNode(n: MockNode): string {
  const t = (n.node_type as string | undefined) ?? n.metadata?.elementType;
  switch (t) {
    case 'image':
      return '🖼';
    case 'video':
      return '🎬';
    case 'link':
      return '🔗';
    case 'code':
      return '⌨';
    case 'quote':
      return '“';
    case 'page':
      return '📄';
    case 'action':
      return '⚡';
    default:
      return '📝';
  }
}
