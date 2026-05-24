/**
 * /notes/:id — single note view with TipTap editor and auto-save.
 *
 * Right-side rail shows linked-to / linked-from notes (wiki-link backrefs).
 */

import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import NoteEditor from '@/components/NoteEditor';

export default function NoteDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['note', id],
    queryFn: () => api.getNote(id),
    enabled: Boolean(id),
  });

  useEffect(() => {
    if (data?.note.title) setTitle(data.note.title);
  }, [data?.note.id]); // only when note id changes, not on every fetch

  const save = useMutation({
    mutationFn: (patch: { title?: string; content?: string; html?: string }) =>
      api.updateNote(id, patch),
    onMutate: () => setSaving(true),
    onSettled: () => {
      setSaving(false);
      setSavedAt(new Date());
      qc.invalidateQueries({ queryKey: ['note', id] });
      qc.invalidateQueries({ queryKey: ['notes'] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteNote(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notes'] });
      nav('/notes');
    },
  });

  // Debounced title save when the input is blurred.
  const flushTitle = () => {
    if (data && title.trim() && title !== data.note.title) {
      save.mutate({ title: title.trim() });
    }
  };

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Link to="/notes" className="text-sm text-accent hover:underline">
          ← Back to notes
        </Link>
        <p className="mt-6 rounded-md border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">
          Note not found.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl gap-6 p-4 md:p-8">
      <div className="min-w-0 flex-1">
        <div className="mb-4 flex items-center justify-between text-xs text-neutral-500">
          <Link to="/notes" className="hover:text-accent">
            ← All notes
          </Link>
          <div className="flex items-center gap-3">
            <span>
              {saving
                ? 'Saving…'
                : savedAt
                  ? `Saved ${formatDistanceToNow(savedAt, { addSuffix: true })}`
                  : data?.note.updated_at
                    ? `Edited ${formatDistanceToNow(new Date(data.note.updated_at), { addSuffix: true })}`
                    : ''}
            </span>
            <button
              onClick={() => {
                if (window.confirm('Delete this note? This cannot be undone.')) {
                  remove.mutate();
                }
              }}
              className="rounded border border-red-900 px-2 py-1 text-red-400 hover:bg-red-950"
            >
              Delete
            </button>
          </div>
        </div>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={flushTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Untitled"
          className="mb-4 w-full border-none bg-transparent text-3xl font-semibold text-neutral-100 placeholder-neutral-700 focus:outline-none"
        />

        {isLoading ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : (
          data && (
            <NoteEditor
              key={data.note.id}
              initialContent={data.note.content}
              onChange={(md, html) => save.mutate({ content: md, html })}
            />
          )
        )}
      </div>

      {/* Backlinks rail */}
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-4 space-y-4 text-xs">
          {(data?.links_out.length ?? 0) > 0 && (
            <section>
              <h3 className="mb-2 font-medium uppercase tracking-widest text-neutral-500">
                Links to →
              </h3>
              <ul className="space-y-1">
                {data?.links_out.map((l) => (
                  <li key={l.id}>
                    <Link
                      to={`/notes/${l.id}`}
                      className="block truncate rounded px-2 py-1 text-neutral-300 hover:bg-neutral-900 hover:text-accent"
                    >
                      {l.title || '(untitled)'}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(data?.links_in.length ?? 0) > 0 && (
            <section>
              <h3 className="mb-2 font-medium uppercase tracking-widest text-neutral-500">
                ← Linked from
              </h3>
              <ul className="space-y-1">
                {data?.links_in.map((l) => (
                  <li key={l.id}>
                    <Link
                      to={`/notes/${l.id}`}
                      className="block truncate rounded px-2 py-1 text-neutral-300 hover:bg-neutral-900 hover:text-accent"
                    >
                      {l.title || '(untitled)'}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="mb-2 font-medium uppercase tracking-widest text-neutral-500">
              Tip
            </h3>
            <p className="rounded-md border border-neutral-800 bg-neutral-900/40 p-2 leading-relaxed text-neutral-500">
              Type <code className="text-accent">[[Note title]]</code> in the body to
              link another note. Markdown shortcuts work: <code>**bold**</code>,{' '}
              <code>## heading</code>, <code>- list</code>.
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}
