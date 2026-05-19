import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { api, type SearchFilters } from '@/lib/api-client';
import type { MockNode, NodeType } from '@/lib/mock';
import { SkeletonList } from '@/components/Skeleton';

const SOURCES = [
  { id: 'extension', label: 'Extension' },
  { id: 'connector:gmail', label: 'Gmail' },
  { id: 'connector:gcal', label: 'Calendar' },
  { id: 'connector:slack', label: 'Slack' },
  { id: 'connector:notion', label: 'Notion' },
  { id: 'manual', label: 'Manual' },
  { id: 'mcp', label: 'MCP' },
];

const NODE_TYPES: { id: NodeType; label: string; color: string }[] = [
  { id: 'text', label: 'Text', color: '#60a5fa' },
  { id: 'image', label: 'Image', color: '#f472b6' },
  { id: 'video', label: 'Video', color: '#fb923c' },
  { id: 'link', label: 'Link', color: '#22d3ee' },
  { id: 'code', label: 'Code', color: '#a78bfa' },
  { id: 'quote', label: 'Quote', color: '#facc15' },
  { id: 'page', label: 'Page', color: '#34d399' },
  { id: 'action', label: 'Action', color: '#e879f9' },
];

const DATE_RANGES = [
  { id: 'all', label: 'All time' },
  { id: '24h', label: 'Last 24h' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
];

interface Filters {
  sources: string[];
  tags: string;
  dateRange: string;
  nodeTypes: NodeType[];
  collectionId: string;
  author: string;
}

const EMPTY: Filters = {
  sources: [],
  tags: '',
  dateRange: 'all',
  nodeTypes: [],
  collectionId: '',
  author: '',
};

function buildApiFilters(f: Filters): SearchFilters {
  const out: SearchFilters = {};
  if (f.sources.length === 1) out.source = f.sources[0];
  if (f.tags.trim()) {
    out.tags = f.tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }
  if (f.dateRange !== 'all') out.since = f.dateRange;
  if (f.nodeTypes.length > 0) out.node_types = f.nodeTypes;
  if (f.collectionId) out.collection_id = f.collectionId;
  if (f.author.trim()) out.author = f.author.trim();
  return out;
}

type Result = MockNode & { score: number };

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [reranked, setReranked] = useState<boolean | null>(null);

  const { data: collections } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.listCollections(),
    staleTime: 60_000,
  });

  const search = useMutation({
    mutationFn: ({ q, f }: { q: string; f: Filters }) =>
      api.search(q, 20, { filters: buildApiFilters(f), rerank: true }),
    onSuccess: (data) => setReranked(data.reranked ?? null),
  });

  const results: Result[] = useMemo(
    () => (search.data?.results ?? []) as Result[],
    [search.data],
  );

  // Multi-source filter is enforced client-side because the backend takes a
  // single `source` only (intentional: keeps the SQL filter cheap).
  const filtered = useMemo(() => {
    if (filters.sources.length <= 1) return results;
    return results.filter((r) => filters.sources.includes(r.source));
  }, [results, filters.sources]);

  // Re-run search automatically when filters change (debounced) — only if a
  // query has been entered. Avoids the surprise of stale results once you
  // toggle a filter.
  useEffect(() => {
    if (!query.trim()) return;
    const t = setTimeout(() => search.mutate({ q: query, f: filters }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const toggleSource = (id: string) => {
    setFilters((f) => ({
      ...f,
      sources: f.sources.includes(id) ? f.sources.filter((s) => s !== id) : [...f.sources, id],
    }));
  };
  const toggleType = (id: NodeType) => {
    setFilters((f) => ({
      ...f,
      nodeTypes: f.nodeTypes.includes(id)
        ? f.nodeTypes.filter((t) => t !== id)
        : [...f.nodeTypes, id],
    }));
  };

  const activeFilterCount =
    (filters.sources.length > 0 ? 1 : 0) +
    (filters.tags.trim() ? 1 : 0) +
    (filters.dateRange !== 'all' ? 1 : 0) +
    (filters.nodeTypes.length > 0 ? 1 : 0) +
    (filters.collectionId ? 1 : 0) +
    (filters.author.trim() ? 1 : 0);

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-semibold">Search your memory</h1>
      <p className="mb-6 text-xs text-neutral-500">
        Hybrid vector + full-text search, reranked by an LLM on the top candidates.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) search.mutate({ q: query, f: filters });
        }}
        className="mb-6 flex gap-2"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What do you want to find?"
          className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          disabled={search.isPending}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
        >
          {search.isPending ? 'Searching…' : 'Search'}
        </button>
      </form>

      <div className="grid gap-4 md:gap-6 lg:grid-cols-[240px_1fr]">
        <aside className="space-y-5 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-widest text-neutral-500">
              Filters
            </span>
            {activeFilterCount > 0 && (
              <button
                onClick={() => setFilters(EMPTY)}
                className="text-xs text-neutral-500 hover:text-neutral-300"
              >
                Clear all
              </button>
            )}
          </div>

          <FilterGroup label="Entry type">
            <ul className="grid grid-cols-2 gap-1">
              {NODE_TYPES.map((t) => {
                const active = filters.nodeTypes.includes(t.id);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => toggleType(t.id)}
                      className={`flex w-full items-center gap-1.5 rounded border px-1.5 py-1 text-[11px] ${
                        active
                          ? 'border-neutral-600 bg-neutral-800 text-neutral-100'
                          : 'border-neutral-800 text-neutral-400 hover:bg-neutral-900/60'
                      }`}
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: t.color }}
                      />
                      {t.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </FilterGroup>

          <FilterGroup label="Sources">
            <ul className="space-y-1">
              {SOURCES.map((s) => (
                <li key={s.id}>
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-300">
                    <input
                      type="checkbox"
                      checked={filters.sources.includes(s.id)}
                      onChange={() => toggleSource(s.id)}
                      className="h-3 w-3 accent-accent"
                    />
                    {s.label}
                  </label>
                </li>
              ))}
            </ul>
          </FilterGroup>

          <FilterGroup label="Collection">
            <select
              value={filters.collectionId}
              onChange={(e) => setFilters((f) => ({ ...f, collectionId: e.target.value }))}
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs focus:border-accent focus:outline-none"
            >
              <option value="">Any</option>
              {(collections ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.icon ? `${c.icon} ` : ''}
                  {c.name}
                </option>
              ))}
            </select>
          </FilterGroup>

          <FilterGroup label="Author">
            <input
              placeholder="e.g. Stratechery"
              value={filters.author}
              onChange={(e) => setFilters((f) => ({ ...f, author: e.target.value }))}
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs placeholder-neutral-600 focus:border-accent focus:outline-none"
            />
          </FilterGroup>

          <FilterGroup label="Tags">
            <input
              placeholder="e.g. work, sophie"
              value={filters.tags}
              onChange={(e) => setFilters((f) => ({ ...f, tags: e.target.value }))}
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs placeholder-neutral-600 focus:border-accent focus:outline-none"
            />
            <p className="mt-1 text-[10px] text-neutral-600">Comma-separated.</p>
          </FilterGroup>

          <FilterGroup label="Date range">
            <select
              value={filters.dateRange}
              onChange={(e) => setFilters((f) => ({ ...f, dateRange: e.target.value }))}
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs focus:border-accent focus:outline-none"
            >
              {DATE_RANGES.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </FilterGroup>
        </aside>

        <section>
          {search.isSuccess && (
            <p className="mb-3 text-xs text-neutral-500">
              {filtered.length} result{filtered.length === 1 ? '' : 's'}
              {reranked ? ' · reranked' : ''}
            </p>
          )}
          {search.isPending && <SkeletonList count={4} />}
          <ul className="flex flex-col gap-2">
            {filtered.map((r) => (
              <ResultCard key={r.id} node={r} />
            ))}
            {search.isSuccess && filtered.length === 0 && (
              <li className="rounded-md border border-dashed border-neutral-800 p-6 text-center text-xs text-neutral-500">
                No matches.
              </li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}

function ResultCard({ node }: { node: Result }) {
  const ex = node.metadata?.extracted;
  const t = node.node_type ?? ex?.node_type ?? 'text';
  const typeMeta = NODE_TYPES.find((x) => x.id === t);
  const title = ex?.title ?? node.summary ?? node.content.slice(0, 120);
  const desc = ex?.description ?? node.summary ?? null;
  const author = ex?.author;
  const thumb = ex?.media_thumbnail ?? (t === 'image' ? ex?.media_url : null);

  return (
    <li className="overflow-hidden rounded-md border border-neutral-800 bg-neutral-900">
      <div className="flex items-stretch gap-3 p-4">
        {thumb && (
          <img
            src={thumb}
            alt=""
            className="h-16 w-16 flex-none rounded object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px] text-neutral-500">
            {typeMeta && (
              <span
                className="rounded px-1.5 py-0.5 font-medium"
                style={{ background: typeMeta.color + '22', color: typeMeta.color }}
              >
                {typeMeta.label}
              </span>
            )}
            <span>{node.source_app ?? node.source}</span>
            <span>·</span>
            <span>{formatDistanceToNow(new Date(node.created_at), { addSuffix: true })}</span>
            {author && (
              <>
                <span>·</span>
                <span className="text-neutral-400">{author}</span>
              </>
            )}
            <span className="ml-auto text-neutral-500">
              {(node.score * 100).toFixed(0)}%
            </span>
          </div>
          <p className="text-sm font-medium text-neutral-100">{title}</p>
          {desc && desc !== title && (
            <p className="mt-1 line-clamp-2 text-xs text-neutral-400">{desc}</p>
          )}
          {node.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {node.tags.slice(0, 6).map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
        {label}
      </div>
      {children}
    </div>
  );
}
