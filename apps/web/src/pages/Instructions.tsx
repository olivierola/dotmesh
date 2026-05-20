/**
 * Custom Instructions page.
 *
 * Grid of cards (title • context • instruction). Each card is a reusable
 * directive the user wants prepended to AI prompts. The Mesh extension
 * picks the most relevant ones at inject time via embedding similarity
 * between the user's prompt and the instruction's text.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import { SkeletonCard } from '@/components/Skeleton';

type Instruction = Awaited<ReturnType<typeof api.listInstructions>>[number];

const EMOJI_PRESETS = ['🧠', '💬', '📝', '🛠️', '🎯', '🎨', '📚', '🔬', '⚡', '🌍'];
const COLOR_PRESETS = ['#f5b301', '#60a5fa', '#34d399', '#f472b6', '#a78bfa', '#fb923c'];

export default function InstructionsPage() {
  const qc = useQueryClient();
  const { data: instructions, isLoading } = useQuery({
    queryKey: ['instructions'],
    queryFn: () => api.listInstructions(),
  });

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Instruction | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteInstruction(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instructions'] }),
  });

  const toggle = useMutation({
    mutationFn: (it: Instruction) =>
      api.updateInstruction(it.id, { enabled: !it.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['instructions'] }),
  });

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Custom Instructions</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Reusable directives you want prepended to AI prompts. The Mesh
            extension picks the most relevant one(s) automatically — based on
            what you're asking — and injects them into the conversation. Many
            prompts won't need any: nothing gets added unless it actually fits.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600"
        >
          + New instruction
        </button>
      </header>

      {isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {instructions && instructions.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-800 bg-neutral-900/30 p-8 text-center text-sm text-neutral-500">
          No instructions yet. Click "New instruction" to add your first one.
        </div>
      )}

      {instructions && instructions.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {instructions.map((it) => (
            <InstructionCard
              key={it.id}
              it={it}
              onEdit={() => setEditing(it)}
              onDelete={() => {
                if (window.confirm(`Delete "${it.title}"?`)) remove.mutate(it.id);
              }}
              onToggle={() => toggle.mutate(it)}
            />
          ))}
        </div>
      )}

      {(creating || editing) && (
        <InstructionEditor
          existing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => qc.invalidateQueries({ queryKey: ['instructions'] })}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- */
/*                       Instruction card                            */
/* --------------------------------------------------------------- */

function InstructionCard({
  it,
  onEdit,
  onDelete,
  onToggle,
}: {
  it: Instruction;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const accent = it.color || '#f5b301';
  return (
    <article
      className={`group relative flex flex-col gap-3 overflow-hidden rounded-xl border bg-neutral-900/40 p-4 transition-colors hover:border-neutral-700 ${
        it.enabled ? 'border-neutral-800' : 'border-neutral-900 opacity-60'
      }`}
      style={it.enabled ? { boxShadow: `inset 3px 0 0 ${accent}` } : undefined}
    >
      <div className="flex items-start gap-3">
        <div
          className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-neutral-800 bg-neutral-950 text-lg"
          style={it.color ? { borderColor: `${accent}40` } : undefined}
        >
          {it.icon ?? '🧠'}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-neutral-100">
            {it.title}
            {!it.indexed && (
              <span
                className="ml-2 rounded border border-neutral-700 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-widest text-neutral-500"
                title="Still being embedded — won't be matched until indexing completes."
              >
                indexing…
              </span>
            )}
          </h3>
          {it.context && (
            <p className="mt-0.5 line-clamp-2 text-xs text-neutral-400">
              {it.context}
            </p>
          )}
        </div>
      </div>

      {/* Body preview */}
      <p className="line-clamp-4 whitespace-pre-wrap text-xs text-neutral-300">
        {it.instruction}
      </p>

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span>updated {formatDistanceToNow(new Date(it.updated_at), { addSuffix: true })}</span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-neutral-900 pt-3 text-xs">
        <button
          onClick={onToggle}
          className={
            it.enabled
              ? 'text-accent hover:underline'
              : 'text-neutral-500 hover:text-accent'
          }
          title={it.enabled ? 'Disable' : 'Enable'}
        >
          {it.enabled ? '● Enabled' : '○ Disabled'}
        </button>
        <span className="ml-auto flex gap-3 text-neutral-500">
          <button
            onClick={onEdit}
            className="hover:text-neutral-200"
            title="Edit"
          >
            ✎
          </button>
          <button
            onClick={onDelete}
            className="hover:text-red-400"
            title="Delete"
          >
            ×
          </button>
        </span>
      </div>
    </article>
  );
}

/* --------------------------------------------------------------- */
/*                       Editor modal                                */
/* --------------------------------------------------------------- */

function InstructionEditor({
  existing,
  onClose,
  onSaved,
}: {
  existing: Instruction | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [context, setContext] = useState(existing?.context ?? '');
  const [body, setBody] = useState(existing?.instruction ?? '');
  const [icon, setIcon] = useState(existing?.icon ?? '🧠');
  const [color, setColor] = useState(existing?.color ?? '#f5b301');

  const isEdit = !!existing;

  const save = useMutation({
    mutationFn: async () => {
      if (isEdit) {
        await api.updateInstruction(existing!.id, {
          title: title.trim(),
          context: context.trim() || null,
          instruction: body.trim(),
          icon,
          color,
        });
      } else {
        await api.createInstruction({
          title: title.trim(),
          context: context.trim() || undefined,
          instruction: body.trim(),
          icon,
          color,
        });
      }
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
  });

  const canSave = title.trim().length > 0 && body.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-xl rounded-xl border border-neutral-800 bg-neutral-950 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {isEdit ? 'Edit instruction' : 'New instruction'}
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-200"
          >
            ✕
          </button>
        </header>

        <div className="space-y-4 text-sm">
          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-widest text-neutral-500">
              Title
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Always reply in French"
              className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 focus:border-accent focus:outline-none"
              autoFocus
            />
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-widest text-neutral-500">
              When this applies (context)
            </label>
            <input
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="e.g. for any code question or react debugging"
              className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 focus:border-accent focus:outline-none"
            />
            <p className="mt-1 text-[10px] text-neutral-500">
              Optional — helps the matcher decide when to inject this instruction.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-[10px] uppercase tracking-widest text-neutral-500">
              Instruction
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder="Tell the AI exactly how to behave when this matches."
              className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 focus:border-accent focus:outline-none"
            />
            <p className="mt-1 text-[10px] text-neutral-500">
              {body.length} / 4000 chars
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[10px] uppercase tracking-widest text-neutral-500">
                Icon
              </label>
              <div className="flex flex-wrap gap-1.5">
                {EMOJI_PRESETS.map((e) => (
                  <button
                    key={e}
                    onClick={() => setIcon(e)}
                    className={`grid h-8 w-8 place-items-center rounded border text-sm ${
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
              <label className="mb-1 block text-[10px] uppercase tracking-widest text-neutral-500">
                Accent
              </label>
              <div className="flex flex-wrap gap-1.5">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`h-8 w-8 rounded border-2 ${
                      color === c ? 'border-white' : 'border-neutral-800'
                    }`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <footer className="mt-5 flex justify-end gap-2 border-t border-neutral-800 pt-4">
          <button
            onClick={onClose}
            className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:border-neutral-600"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={!canSave || save.isPending}
            className="rounded bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : isEdit ? 'Save' : 'Create'}
          </button>
        </footer>
      </div>
    </div>
  );
}
