import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import type { MockNode } from '@/lib/mock';
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
}

const EMPTY: Filters = { sources: [], tags: '', dateRange: 'all' };

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [results, setResults] = useState<Array<MockNode & { score: number }>>([]);

  const search = useMutation({
    mutationFn: (q: string) => api.search(q, 30),
    onSuccess: (data) => setResults(data.results),
  });

  const filtered = useMemo(() => {
    const tagFilters = filters.tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const sinceMs = (() => {
      switch (filters.dateRange) {
        case '24h':
          return Date.now() - 86400_000;
        case '7d':
          return Date.now() - 7 * 86400_000;
        case '30d':
          return Date.now() - 30 * 86400_000;
        default:
          return 0;
      }
    })();

    return results.filter((r) => {
      if (filters.sources.length > 0 && !filters.sources.includes(r.source)) return false;
      if (tagFilters.length > 0) {
        const hay = r.tags.map((t) => t.toLowerCase());
        if (!tagFilters.some((t) => hay.includes(t))) return false;
      }
      if (sinceMs > 0 && new Date(r.created_at).getTime() < sinceMs) return false;
      return true;
    });
  }, [results, filters]);

  const toggleSource = (id: string) => {
    setFilters((f) => ({
      ...f,
      sources: f.sources.includes(id) ? f.sources.filter((s) => s !== id) : [...f.sources, id],
    }));
  };

  const activeFilterCount =
    (filters.sources.length > 0 ? 1 : 0) +
    (filters.tags.trim() ? 1 : 0) +
    (filters.dateRange !== 'all' ? 1 : 0);

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 className="mb-6 text-2xl font-semibold">Search your memory</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) search.mutate(query);
        }}
        className="mb-6 flex gap-2"
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Try 'Sophie' or 'agent memory'"
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

      <div className="grid gap-4 md:gap-6 lg:grid-cols-[220px_1fr]">
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
              {filtered.length} of {results.length} results
              {activeFilterCount > 0 && ` (filtered)`}
            </p>
          )}
          {search.isPending && <SkeletonList count={4} />}
          <ul className="flex flex-col gap-2">
            {filtered.map((r) => (
              <li
                key={r.id}
                className="rounded-md border border-neutral-800 bg-neutral-900 p-4 text-sm"
              >
                <div className="mb-1 flex items-center justify-between text-xs text-neutral-500">
                  <span>
                    {r.source} ·{' '}
                    {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                  </span>
                  <span>relevance {(r.score * 100).toFixed(0)}%</span>
                </div>
                <p className="text-neutral-200">{r.summary ?? r.content.slice(0, 240)}</p>
                {r.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full border border-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400"
                      >
                        #{t}
                      </span>
                    ))}
                  </div>
                )}
              </li>
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
