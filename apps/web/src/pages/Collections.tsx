import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import { SkeletonCard } from '@/components/Skeleton';

type Collection = Awaited<ReturnType<typeof api.listCollections>>[number];

const EMOJI_PRESETS = ['📚', '💼', '🧠', '🎨', '💬', '📰', '🛠️', '🎓', '❤️', '🔬', '🎯', '🍕'];

export default function CollectionsPage() {
  const qc = useQueryClient();
  const { data: collections, isLoading } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.listCollections(),
  });

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Collection | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteCollection(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collections'] }),
  });

  const togglePin = useMutation({
    mutationFn: (c: Collection) => api.updateCollection(c.id, { pinned: !c.pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collections'] }),
  });

  const reclassifyOrphans = useMutation({
    mutationFn: () => api.reclassifyOrphansWithLLM(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['collections'] });
      const created = res.created.length;
      const msg =
        res.scanned === 0
          ? 'Nothing in Inbox needed reclassifying.'
          : `Scanned ${res.scanned} Inbox memories — reassigned ${res.reassigned}` +
            (created > 0 ? `, created ${created} new collection${created > 1 ? 's' : ''}.` : '.') +
            (res.skipped ? ` ${res.skipped} more queued for next run.` : '');
      window.alert(msg);
    },
    onError: (e) => window.alert(`Reclassify failed: ${(e as Error).message}`),
  });

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Collections</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Slice your memory into themes. Each collection collects matching captures
            automatically, and you can scope embeds & agents to one of them.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => {
              if (
                window.confirm(
                  'Use AI to reassign memories currently sitting only in Inbox? ' +
                    'Up to 50 memories will be reclassified into existing collections, ' +
                    'and a new collection may be proposed if a clear theme emerges.',
                )
              ) {
                reclassifyOrphans.mutate();
              }
            }}
            disabled={reclassifyOrphans.isPending}
            className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
            title="Run the AI classifier on Inbox-only memories"
          >
            {reclassifyOrphans.isPending ? 'Reclassifying…' : '✨ Reclassify Inbox'}
          </button>
          <button
            onClick={() => setCreating(true)}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600"
          >
            + New collection
          </button>
        </div>
      </header>

      {isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {collections && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {collections.map((c) => (
            <CollectionCard
              key={c.id}
              collection={c}
              onEdit={() => setEditing(c)}
              onDelete={() => {
                if (c.is_default) return;
                if (
                  window.confirm(
                    `Delete "${c.name}"? Captures stay in your memory, only the grouping is removed.`,
                  )
                ) {
                  remove.mutate(c.id);
                }
              }}
              onPin={() => togglePin.mutate(c)}
            />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <CollectionEditor
          existing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => qc.invalidateQueries({ queryKey: ['collections'] })}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- */
/*                        Collection Card                            */
/* --------------------------------------------------------------- */

function CollectionCard({
  collection,
  onEdit,
  onDelete,
  onPin,
}: {
  collection: Collection;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
}) {
  const c = collection;
  const accent = c.color || '#f5b301';
  return (
    <article
      className="group relative flex flex-col gap-3 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 transition-colors hover:border-neutral-700"
      style={{ boxShadow: c.pinned ? `inset 4px 0 0 ${accent}` : undefined }}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-neutral-800 bg-neutral-950 text-lg"
          style={c.color ? { borderColor: `${accent}40` } : undefined}
        >
          {c.icon ?? (c.is_default ? '📥' : '🗂')}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-neutral-100">
            <Link to={`/collections/${c.id}`} className="hover:text-accent">
              {c.name}
            </Link>
            {c.is_default && (
              <span className="ml-2 rounded border border-neutral-700 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-widest text-neutral-400">
                default
              </span>
            )}
          </h3>
          <p className="mt-0.5 line-clamp-2 text-xs text-neutral-400">
            {c.description ?? c.rule_prompt ?? 'No description.'}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span>
          <strong className="text-neutral-200">{c.node_count}</strong>{' '}
          {c.node_count === 1 ? 'memory' : 'memories'}
        </span>
        {c.last_node_at && (
          <span title={new Date(c.last_node_at).toISOString()}>
            updated {formatDistanceToNow(new Date(c.last_node_at), { addSuffix: true })}
          </span>
        )}
      </div>

      {/* Filter chips (compact) */}
      <FilterPreview filter={c.filter as Record<string, unknown>} />

      {/* Actions overlay */}
      <div className="flex items-center gap-1 border-t border-neutral-900 pt-3 text-xs">
        {!c.is_default && (
          <button
            onClick={onPin}
            className={c.pinned ? 'text-accent' : 'text-neutral-500 hover:text-accent'}
            title={c.pinned ? 'Unpin' : 'Pin'}
          >
            ★
          </button>
        )}
        <div className="flex-1" />
        <Link
          to={`/collections/${c.id}`}
          className="rounded border border-neutral-800 px-2 py-1 text-neutral-300 hover:border-neutral-700"
        >
          Open
        </Link>
        <button
          onClick={onEdit}
          className="rounded border border-neutral-800 px-2 py-1 text-neutral-300 hover:border-neutral-700"
        >
          Edit
        </button>
        {!c.is_default && (
          <button
            onClick={onDelete}
            className="rounded border border-red-900 px-2 py-1 text-red-400 hover:bg-red-950"
          >
            Delete
          </button>
        )}
      </div>
    </article>
  );
}

function FilterPreview({ filter }: { filter: Record<string, unknown> }) {
  const chips: Array<{ label: string; value: string }> = [];
  const add = (label: string, arr: unknown) => {
    if (!Array.isArray(arr) || arr.length === 0) return;
    chips.push({ label, value: (arr as string[]).slice(0, 3).join(', ') + (arr.length > 3 ? '…' : '') });
  };
  add('sources', filter.sources);
  add('tags', filter.tags);
  add('domains', filter.domains);
  add('keywords', filter.keywords);
  if (chips.length === 0) {
    return (
      <p className="text-[11px] italic text-neutral-600">
        No rules — fallback bucket for unmatched captures.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-full border border-neutral-800 bg-neutral-950/60 px-2 py-0.5 text-[10px] text-neutral-300"
        >
          <span className="font-medium text-neutral-500">{c.label}:</span>
          <span className="truncate max-w-[140px]">{c.value}</span>
        </span>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- */
/*                       Collection Editor                           */
/* --------------------------------------------------------------- */

function CollectionEditor({
  existing,
  onClose,
  onSaved,
}: {
  existing: Collection | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [rulePrompt, setRulePrompt] = useState(existing?.rule_prompt ?? '');
  const [icon, setIcon] = useState(existing?.icon ?? '🗂');
  const [color] = useState(existing?.color ?? '');
  const [preview, setPreview] = useState<{ matched: number; sampled: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => {
    if (!existing) return name.length > 0;
    return (
      name !== existing.name ||
      description !== (existing.description ?? '') ||
      rulePrompt !== (existing.rule_prompt ?? '') ||
      icon !== (existing.icon ?? '🗂') ||
      color !== (existing.color ?? '')
    );
  }, [name, description, rulePrompt, icon, color, existing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runPreview = async () => {
    if (!rulePrompt.trim()) return;
    setPreviewing(true);
    setError(null);
    try {
      const res = await api.previewCollectionRules(rulePrompt);
      setPreview({ matched: res.matched, sampled: res.sampled });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (existing) {
        await api.updateCollection(existing.id, {
          name,
          description: description || undefined,
          rule_prompt: rulePrompt || undefined,
          icon,
          color: color || undefined,
        });
      } else {
        await api.createCollection({
          name,
          description: description || undefined,
          rule_prompt: rulePrompt || undefined,
          icon,
          color: color || undefined,
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-neutral-900 p-4">
          <h2 className="text-base font-semibold">
            {existing ? 'Edit collection' : 'New collection'}
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-widest text-neutral-500">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Work, Reading, Health…"
              maxLength={80}
              autoFocus
              className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-widest text-neutral-500">
              Icon
            </label>
            <div className="flex flex-wrap gap-1.5">
              {EMOJI_PRESETS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => setIcon(e)}
                  className={`h-9 w-9 rounded-md border text-lg transition-colors ${
                    icon === e
                      ? 'border-accent bg-accent/10'
                      : 'border-neutral-800 hover:border-neutral-700'
                  }`}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-widest text-neutral-500">
              Description (optional)
            </label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this collection about?"
              maxLength={400}
              className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <div className="mb-1 flex items-baseline justify-between">
              <label className="text-xs font-medium uppercase tracking-widest text-neutral-500">
                Rules (natural language)
              </label>
              <button
                type="button"
                onClick={runPreview}
                disabled={previewing || !rulePrompt.trim()}
                className="text-xs text-accent hover:underline disabled:opacity-50"
              >
                {previewing ? 'Analyzing…' : 'Preview matches'}
              </button>
            </div>
            <textarea
              value={rulePrompt}
              onChange={(e) => setRulePrompt(e.target.value)}
              placeholder={`e.g. "Everything from Slack and my AI chats with Claude or ChatGPT, exclude anything tagged personal"`}
              rows={3}
              maxLength={800}
              className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-accent focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-neutral-500">
              Describe what belongs in this collection. Mesh will translate it into structured
              filters automatically.
            </p>
            {preview && (
              <div className="mt-2 rounded-md border border-neutral-800 bg-neutral-900/60 p-2 text-xs text-neutral-300">
                <span className="font-semibold text-accent">{preview.matched}</span> of the last{' '}
                <span className="text-neutral-100">{preview.sampled}</span> memories would match.
              </div>
            )}
          </div>

          {error && (
            <p className="rounded-md border border-red-900 bg-red-950/30 p-2 text-xs text-red-300">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-neutral-900 bg-neutral-950 p-3">
          <button
            onClick={onClose}
            className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-700"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !name.trim() || !dirty}
            className="rounded-md bg-accent px-4 py-1.5 text-xs font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
          >
            {saving ? 'Saving…' : existing ? 'Save changes' : 'Create'}
          </button>
        </footer>
      </div>
    </div>
  );
}

void useState; // tree-shake guard
