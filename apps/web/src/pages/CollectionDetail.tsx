/**
 * Single collection view at /collections/:id.
 *
 * Shows the collection header (name, icon, rule prompt, node count) and a
 * paginated list of the memories that currently belong to it. Each row links
 * back to the source URL when present and lets the user pin/unpin or open
 * the full content in a modal.
 */

import { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import { SkeletonList } from '@/components/Skeleton';

export default function CollectionDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data: collection, isLoading: loadingCol, error } = useQuery({
    queryKey: ['collection', id],
    queryFn: () => api.getCollection(id),
    enabled: Boolean(id),
  });

  const { data: nodesRes, isLoading: loadingNodes } = useQuery({
    queryKey: ['collection-nodes', id],
    queryFn: () => api.listCollectionNodes(id, { limit: 100 }),
    enabled: Boolean(id),
  });

  const reclassify = useMutation({
    mutationFn: () => api.reclassifyCollection(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collection', id] });
      qc.invalidateQueries({ queryKey: ['collection-nodes', id] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteCollection(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collections'] });
      nav('/collections');
    },
  });

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Link to="/collections" className="text-sm text-accent hover:underline">
          ← Back to collections
        </Link>
        <p className="mt-6 rounded-md border border-red-900 bg-red-950/30 p-4 text-sm text-red-300">
          Collection not found.
        </p>
      </div>
    );
  }

  const accent = collection?.color || '#f5b301';
  const nodes = nodesRes?.nodes ?? [];

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8">
      <Link to="/collections" className="text-xs text-neutral-400 hover:text-accent">
        ← All collections
      </Link>

      {loadingCol && <SkeletonList count={2} />}

      {collection && (
        <header className="mt-3 flex flex-col gap-3 border-b border-neutral-900 pb-6 md:flex-row md:items-start">
          <div
            className="grid h-14 w-14 shrink-0 place-items-center rounded-xl border border-neutral-800 bg-neutral-950 text-2xl"
            style={{ borderColor: `${accent}40` }}
          >
            {collection.icon ?? (collection.is_default ? '📥' : '🗂')}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold text-neutral-100">{collection.name}</h1>
            {collection.description && (
              <p className="mt-1 text-sm text-neutral-400">{collection.description}</p>
            )}
            {collection.rule_prompt && (
              <p className="mt-2 rounded-md border border-neutral-800 bg-neutral-900/40 p-2 text-xs italic text-neutral-400">
                Rule: {collection.rule_prompt}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-neutral-500">
              <span>
                <strong className="text-neutral-200">{collection.node_count}</strong>{' '}
                {collection.node_count === 1 ? 'memory' : 'memories'}
              </span>
              {collection.last_node_at && (
                <span>
                  updated {formatDistanceToNow(new Date(collection.last_node_at), { addSuffix: true })}
                </span>
              )}
              {collection.is_default && (
                <span className="rounded border border-neutral-700 px-1.5 py-0.5 uppercase tracking-widest text-neutral-400">
                  default
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() => reclassify.mutate()}
              disabled={reclassify.isPending}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
              title="Re-run the rule against all your memories"
            >
              {reclassify.isPending ? 'Re-running…' : '↻ Reclassify'}
            </button>
            {!collection.is_default && (
              <button
                onClick={() => {
                  if (window.confirm(`Delete "${collection.name}"? Captures stay in your memory.`)) {
                    remove.mutate();
                  }
                }}
                className="rounded-md border border-red-900 px-3 py-2 text-xs text-red-400 hover:bg-red-950"
              >
                Delete
              </button>
            )}
          </div>
        </header>
      )}

      <section className="mt-6">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-widest text-neutral-500">
          Memories
        </h2>

        {loadingNodes && <SkeletonList count={4} />}

        {!loadingNodes && nodes.length === 0 && (
          <p className="rounded-md border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
            No memories in this collection yet.
            {collection?.rule_prompt
              ? ' Try clicking ↻ Reclassify to re-evaluate your existing memories against the rule.'
              : ' Captures matching its filter will appear here automatically.'}
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {nodes.map((n) => (
            <NodeRow key={n.id} node={n} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function NodeRow({
  node,
}: {
  node: {
    id: string;
    content: string;
    summary: string | null;
    tags: string[];
    source: string;
    source_url: string | null;
    source_app: string | null;
    score: number | null;
    created_at: string;
    pinned: boolean;
    node_type: string | null;
    link_source: string;
  };
}) {
  const [expanded, setExpanded] = useState(false);
  const title =
    (node.summary?.split('\n')[0] ?? '').trim() ||
    (node.content.split('\n')[0] ?? '').slice(0, 120) ||
    '(untitled)';
  const body = node.summary && node.summary !== title ? node.summary : node.content;

  return (
    <li className="overflow-hidden rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-sm transition-colors hover:border-neutral-700">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="block w-full text-left font-medium text-neutral-100 hover:text-accent"
          >
            {node.pinned && <span className="mr-1 text-accent">★</span>}
            {title}
          </button>
          {expanded && (
            <p className="mt-2 whitespace-pre-wrap break-words text-xs text-neutral-300">
              {body}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500">
            <span>{formatDistanceToNow(new Date(node.created_at), { addSuffix: true })}</span>
            {node.source_app && <span>· {node.source_app}</span>}
            {node.node_type && <span>· {node.node_type}</span>}
            {node.link_source !== 'auto' && (
              <span className="rounded border border-neutral-800 px-1 text-[9px] uppercase tracking-wider">
                {node.link_source}
              </span>
            )}
            {(node.tags?.length ?? 0) > 0 && (
              <span className="truncate text-neutral-600">
                {node.tags.slice(0, 4).map((t) => `#${t}`).join(' ')}
              </span>
            )}
          </div>
        </div>
        {node.source_url && (
          <a
            href={node.source_url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-400 hover:border-accent hover:text-accent"
            title={node.source_url}
          >
            open ↗
          </a>
        )}
      </div>
    </li>
  );
}
