/**
 * /notes — list page. Notion-ish grid of note cards, with a New button.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import { SkeletonCard } from '@/components/Skeleton';

export default function NotesPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [q, setQ] = useState('');

  const { data: notes, isLoading } = useQuery({
    queryKey: ['notes'],
    queryFn: () => api.listNotes(),
  });

  const create = useMutation({
    mutationFn: () => api.createNote({ title: 'Untitled', content: '' }),
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ['notes'] });
      nav(`/notes/${id}`);
    },
  });

  const filtered = !q.trim()
    ? notes
    : notes?.filter(
        (n) =>
          n.title.toLowerCase().includes(q.toLowerCase()) ||
          n.content.toLowerCase().includes(q.toLowerCase()),
      );

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Notes</h1>
          <p className="mt-1 text-sm text-neutral-400">
            Your own thoughts, structured. Link notes with{' '}
            <code className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs text-accent">
              [[Note title]]
            </code>{' '}
            to weave them into your memory graph.
          </p>
        </div>
        <button
          onClick={() => create.mutate()}
          disabled={create.isPending}
          className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : '+ New note'}
        </button>
      </header>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter notes…"
        className="mb-6 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm placeholder-neutral-600 focus:border-accent focus:outline-none"
      />

      {isLoading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {!isLoading && (filtered?.length ?? 0) === 0 && (
        <div className="rounded-md border border-dashed border-neutral-800 p-12 text-center text-sm text-neutral-500">
          {q.trim()
            ? 'No notes match that filter.'
            : 'No notes yet. Click + New note to start.'}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {filtered?.map((n) => <NoteCard key={n.id} note={n} />)}
      </div>
    </div>
  );
}

function NoteCard({
  note,
}: {
  note: {
    id: string;
    title: string;
    content: string;
    updated_at: string | null;
    pinned: boolean;
  };
}) {
  const preview = note.content
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[#*`>_-]+/g, '')
    .trim()
    .slice(0, 220);
  return (
    <Link
      to={`/notes/${note.id}`}
      className="group flex flex-col gap-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 transition-colors hover:border-accent/50 hover:bg-neutral-900"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="line-clamp-2 text-sm font-semibold text-neutral-100">
          {note.pinned && <span className="mr-1 text-accent">★</span>}
          {note.title}
        </h3>
      </div>
      {preview ? (
        <p className="line-clamp-4 text-xs leading-relaxed text-neutral-400">{preview}</p>
      ) : (
        <p className="text-xs italic text-neutral-600">Empty note.</p>
      )}
      <div className="mt-auto text-[10px] uppercase tracking-widest text-neutral-600">
        {note.updated_at
          ? `edited ${formatDistanceToNow(new Date(note.updated_at), { addSuffix: true })}`
          : 'new'}
      </div>
    </Link>
  );
}
