import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import type { MockNode } from '@/lib/mock';
import CaptureBar, { type CapturePayload } from '@/components/CaptureBar';
import { SkeletonList } from '@/components/Skeleton';

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

  const sortedNodes = data
    ? [...data.nodes].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.created_at.localeCompare(a.created_at);
      })
    : [];

  const selectedArr = Array.from(selected);
  const allSelected = !!data && data.nodes.length > 0 && selected.size === data.nodes.length;

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

      <ul className="flex flex-col gap-2">
        {sortedNodes.map((n) => (
          <NodeRow
            key={n.id}
            n={n}
            selected={selected.has(n.id)}
            editing={editingId === n.id}
            onToggle={() => toggle(n.id)}
            onStartEdit={() => setEditingId(n.id)}
            onSaveEdit={(text) => {
              update.mutate({ id: n.id, patch: { edited_summary: text, summary: text } });
              setEditingId(null);
            }}
            onCancelEdit={() => setEditingId(null)}
            onTogglePin={() => update.mutate({ id: n.id, patch: { pinned: !n.pinned } })}
            onDelete={() => removeOne.mutate(n.id)}
          />
        ))}
        {data?.nodes.length === 0 && (
          <p className="text-sm text-neutral-500">No memories yet. Add one above.</p>
        )}
      </ul>
    </div>
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
  const [draft, setDraft] = useState(n.summary ?? n.content.slice(0, 240));

  return (
    <li
      className={`flex gap-3 rounded-md border p-4 text-sm ${
        selected ? 'border-accent/60 bg-accent/5' : 'border-neutral-800 bg-neutral-900'
      }`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="mt-1 h-3 w-3 accent-accent"
      />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center justify-between text-xs text-neutral-500">
          <span>
            {n.source} · {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
            {n.pinned && <span className="ml-2 text-accent">★ pinned</span>}
          </span>
          <div className="flex items-center gap-3">
            {n.score != null && <span>score {n.score.toFixed(2)}</span>}
            <button
              onClick={onTogglePin}
              className={n.pinned ? 'text-accent' : 'text-neutral-500 hover:text-accent'}
              title={n.pinned ? 'Unpin' : 'Pin'}
            >
              ★
            </button>
            {!editing && (
              <button
                onClick={() => {
                  setDraft(n.summary ?? n.content.slice(0, 240));
                  onStartEdit();
                }}
                className="text-neutral-500 hover:text-neutral-200"
                title="Edit summary"
              >
                ✎
              </button>
            )}
            <button
              onClick={onDelete}
              className="text-neutral-500 hover:text-red-400"
              title="Delete"
            >
              ×
            </button>
          </div>
        </div>

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
          <p className="text-neutral-200">{n.summary ?? n.content.slice(0, 240)}</p>
        )}

        {n.entities.length > 0 && !editing && (
          <div className="mt-2 flex flex-wrap gap-1">
            {n.entities.slice(0, 6).map((e, i) => (
              <span
                key={i}
                className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400"
              >
                {e.value}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
