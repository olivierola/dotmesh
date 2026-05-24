import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { api, type GraphCollection } from '@/lib/api-client';
import type { MockNode, MockEdge } from '@/lib/mock';
import { Skeleton } from '@/components/Skeleton';
import ForceGraphCanvas, {
  buildCanvasData,
  type CanvasNode,
  type ExtraHubLayer,
} from '@/components/ForceGraphCanvas';

const FALLBACK_PALETTE = [
  '#60a5fa', '#a78bfa', '#34d399', '#f87171', '#fbbf24',
  '#22d3ee', '#f472b6', '#fb923c', '#84cc16', '#e879f9',
];
const INBOX_COLOR = '#737373';
const ORPHAN_COLOR = '#3f3f46';
const HUB_COLOR = '#f5b301';

/**
 * Color per node_type — the dominant visual cue in the graph, as requested.
 * Collections remain visible via the legend + chip in the side panel.
 */
const TYPE_COLORS: Record<string, string> = {
  text:   '#60a5fa', // blue
  image:  '#f472b6', // pink
  video:  '#fb923c', // orange
  link:   '#22d3ee', // cyan
  code:   '#a78bfa', // purple
  quote:  '#facc15', // yellow
  page:   '#34d399', // green
  action: '#e879f9', // magenta
  note:   '#f5b301', // accent — user-authored manual notes
};

/** True for context_nodes that came from the manual /notes editor. */
function isManualNote(n: MockNode): boolean {
  return (
    (n as unknown as { source?: string }).source === 'manual_note' ||
    n.metadata?.is_manual_note === true ||
    (n.metadata?.extracted as { node_type?: string } | undefined)?.node_type === 'note'
  );
}

const RELATION_COLOR: Record<string, string> = {
  belongs_to_page: '#a78bfa',
  navigated_from: '#fb923c',
  same_session: '#52525b',
  mentions: '#22d3ee',
  extends: '#84cc16',
  cites: '#facc15',
  contradicts: '#f87171',
  inferred: '#737373',
  supersedes: '#34d399',
  explicit: '#e5e5e5',
  temporal: '#52525b',
  user_linked: '#f5b301',
  note_link: '#f5b301',
};

const TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  image: 'Image',
  video: 'Video',
  link: 'Link',
  code: 'Code',
  quote: 'Quote',
  page: 'Page',
  action: 'Action',
  note: 'Note',
};

function hashIndex(id: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % mod;
}

function colorForCollection(c: GraphCollection): string {
  if (c.color) return c.color;
  if (c.is_default) return INBOX_COLOR;
  return FALLBACK_PALETTE[hashIndex(c.id, FALLBACK_PALETTE.length)] ?? FALLBACK_PALETTE[0]!;
}

function effectiveNodeType(node: MockNode): string {
  if (isManualNote(node)) return 'note';
  return (
    node.node_type ??
    node.metadata?.extracted?.node_type ??
    (node.metadata?.elementType === 'heading' || node.metadata?.elementType === 'list-item'
      ? 'text'
      : node.metadata?.elementType) ??
    'text'
  );
}

export type ColorMode = 'type' | 'collection' | 'site';

function siteKeyFor(node: MockNode): string | null {
  const host = node.source_app || (() => {
    try {
      return new URL(node.source_url ?? '').hostname;
    } catch {
      return null;
    }
  })();
  if (!host) return null;
  const parts = host.replace(/^www\./, '').split('.');
  if (parts.length >= 2 && parts[0]) {
    if (parts.length === 2) return parts[0].toLowerCase();
    return parts[parts.length - 2]!.toLowerCase();
  }
  return host.toLowerCase();
}

/**
 * Pick a hex color for a node according to the user-chosen dimension.
 * Each mode is deterministic per-node so colors stay stable across renders.
 */
function pickColor(
  node: MockNode,
  mode: ColorMode,
  collectionById: Map<string, GraphCollection>,
): string {
  if (mode === 'type') {
    const t = effectiveNodeType(node);
    return TYPE_COLORS[t] ?? ORPHAN_COLOR;
  }
  if (mode === 'collection') {
    const ids = node.collection_ids ?? [];
    const primary =
      ids.map((id) => collectionById.get(id)).find((c) => c && !c.is_default) ??
      ids.map((id) => collectionById.get(id)).find((c) => !!c);
    if (primary) return colorForCollection(primary);
    return ORPHAN_COLOR;
  }
  // site
  const key = siteKeyFor(node);
  if (!key) return ORPHAN_COLOR;
  return FALLBACK_PALETTE[hashIndex(key, FALLBACK_PALETTE.length)] ?? ORPHAN_COLOR;
}

// Pretty short title for a node label under the dot.
function shortLabel(n: MockNode): string {
  const md = n.metadata ?? {};
  const extracted = md.extracted;
  const candidate =
    extracted?.title ||
    (md.heading as string | undefined) ||
    n.summary?.split(/[.\n]/)[0] ||
    (md.pageTitle as string | undefined) ||
    n.content.split(/[.\n]/)[0] ||
    n.content;
  // Strip leading "[Tag] " markers, normalize whitespace, hard-cap to 24 chars.
  const cleaned = candidate.replace(/\[[^\]]+\]\s*/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 24) return cleaned;
  return cleaned.slice(0, 22).trimEnd() + '…';
}

// Normalize "linkedin.com", "www.linkedin.com", "fr.linkedin.com" → "linkedin"
function hubKey(node: MockNode): string | null {
  const host = node.source_app || (() => {
    try {
      return new URL(node.source_url ?? '').hostname;
    } catch {
      return null;
    }
  })();
  if (!host) return null;
  // Strip leading subdomains (www, fr, en, m...) — keep registrable-ish core
  const parts = host.replace(/^www\./, '').split('.');
  if (parts.length >= 2 && parts[0]) {
    const main = parts[0];
    // Some well-known: claude.ai, chatgpt.com — keep them as-is
    if (parts.length === 2) return main.toLowerCase();
    // For "fr.linkedin.com" → "linkedin"
    return parts[parts.length - 2]!.toLowerCase();
  }
  return host.toLowerCase();
}

function hubLabel(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export default function GraphPage() {
  const [selected, setSelected] = useState<MockNode | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('type');
  const [lineageFocus, setLineageFocus] = useState<string | null>(null);
  const qc = useQueryClient();

  const backfill = useMutation({
    mutationFn: () => api.backfillHierarchy({ limit: 200 }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['graph'] });
      window.alert(
        `Backfill: scanned ${r.scanned} memories — linked ${r.pages_linked} to a page, ` +
          `${r.nav_linked} navigation parents, ${r.sessions_linked} same-session links.` +
          (r.done ? '' : ' Run again to continue.'),
      );
    },
    onError: (e) => window.alert(`Backfill failed: ${(e as Error).message}`),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['graph'],
    queryFn: () => api.loadGraph(),
  });

  const collectionById = useMemo(() => {
    const m = new Map<string, GraphCollection>();
    for (const c of data?.collections ?? []) m.set(c.id, c);
    return m;
  }, [data?.collections]);

  const nodeById = useMemo(() => {
    const m = new Map<string, MockNode>();
    for (const n of data?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [data?.nodes]);

  /** Resolve clickable links (parents, children, related) for the selected node. */
  const selectedLinks: NodeLink[] = useMemo(() => {
    if (!selected || !data) return [];
    const PARENT_RELS = new Set(['belongs_to_page', 'navigated_from']);
    const SELF_PARENT_OUT_RELS = new Set<string>([]); // we are FROM page → child
    const links: NodeLink[] = [];
    for (const e of data.edges) {
      const isFrom = e.from_node === selected.id;
      const isTo = e.to_node === selected.id;
      if (!isFrom && !isTo) continue;
      const otherId = isFrom ? e.to_node : e.from_node;
      const other = nodeById.get(otherId);
      if (!other) continue;
      let direction: NodeLink['direction'];
      if (PARENT_RELS.has(e.relation_type)) {
        // edge direction: from_node = parent → to_node = child
        direction = isTo ? 'parent' : 'child';
      } else if (SELF_PARENT_OUT_RELS.has(e.relation_type)) {
        direction = 'child';
      } else if (e.relation_type === 'same_session') {
        direction = 'related';
      } else {
        // mentions/extends/cites/contradicts/inferred — semantic peer
        direction = 'related';
      }
      links.push({ edgeId: e.id, direction, relation: e.relation_type, node: other });
    }
    // Order: parents first, then children, then related; within each group by
    // relation type so the visual grouping stays predictable.
    const order: Record<NodeLink['direction'], number> = {
      parent: 0,
      child: 1,
      related: 2,
    };
    links.sort((a, b) => {
      if (order[a.direction] !== order[b.direction]) {
        return order[a.direction] - order[b.direction];
      }
      return a.relation.localeCompare(b.relation);
    });
    return links;
  }, [selected, data, nodeById]);

  // Lineage focus: ids of all ancestors + descendants of the focused node
  // via belongs_to_page / navigated_from edges. `null` = no focus, show all.
  const lineageKeep: Set<string> | null = useMemo(() => {
    if (!lineageFocus || !data) return null;
    const HIER = new Set(['belongs_to_page', 'navigated_from']);
    const adjFrom = new Map<string, string[]>();
    const adjTo = new Map<string, string[]>();
    for (const e of data.edges) {
      if (!HIER.has(e.relation_type)) continue;
      (adjFrom.get(e.from_node) ?? adjFrom.set(e.from_node, []).get(e.from_node)!).push(e.to_node);
      (adjTo.get(e.to_node) ?? adjTo.set(e.to_node, []).get(e.to_node)!).push(e.from_node);
    }
    const keep = new Set<string>([lineageFocus]);
    const walk = (start: string, adj: Map<string, string[]>) => {
      let frontier = [start];
      while (frontier.length) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const n of adj.get(id) ?? []) {
            if (!keep.has(n)) { keep.add(n); next.push(n); }
          }
        }
        frontier = next;
      }
    };
    walk(lineageFocus, adjTo);
    walk(lineageFocus, adjFrom);
    return keep;
  }, [lineageFocus, data]);

  // Build the canvas data ONCE per dataset (NOT per colour-mode change).
  // The simulation accumulates positions on these node objects; recreating
  // them would freeze d3-force into a permanent reset loop where every
  // colour toggle wipes positions and re-spawns at the centre.
  const canvasData = useMemo(() => {
    if (!data) return null;
    const hubMembers = new Map<string, string[]>();
    for (const n of data.nodes) {
      const k = hubKey(n);
      if (!k) continue;
      const arr = hubMembers.get(k) ?? [];
      arr.push(n.id);
      hubMembers.set(k, arr);
    }

    // Build the "Me + per-collection sub-hubs" layer. We gather the member
    // node ids for each collection from collection_ids on each node.
    const collectionMembers = new Map<string, string[]>();
    for (const n of data.nodes) {
      for (const cid of n.collection_ids ?? []) {
        const arr = collectionMembers.get(cid) ?? [];
        arr.push(n.id);
        collectionMembers.set(cid, arr);
      }
    }
    // Only show sub-hubs for collections that actually have members.
    const subHubs = (data.collections ?? [])
      .filter((c) => (collectionMembers.get(c.id)?.length ?? 0) > 0)
      .map((c) => ({
        id: `coll:${c.id}`,
        label: c.name,
        color: colorForCollection(c),
        icon: c.icon ?? null,
        members: collectionMembers.get(c.id) ?? [],
      }));

    const extraHubs: ExtraHubLayer | null = subHubs.length > 0
      ? {
          centerId: 'me:hub',
          centerLabel: 'You',
          centerColor: HUB_COLOR,
          centerSize: Math.max(60, subHubs.length * 6),
          subHubs,
        }
      : null;

    return buildCanvasData({
      nodes: data.nodes,
      edges: data.edges,
      hubMembers,
      hubLabel,
      hubKey,
      hubColor: HUB_COLOR,
      extraHubs,
      // Initial colour: 'type' mode. Subsequent changes mutate `color` on
      // the existing node objects (see effect below) without recreating
      // anything, so positions survive.
      pickNodeColor: (n) => pickColor(n, 'type', collectionById),
      pickNodeShape: (n) => {
        // Manual notes get a distinct square shape with accent color so
        // they stand out visually from auto-captured memories.
        if (isManualNote(n)) return 'square';
        const t = effectiveNodeType(n);
        if (t === 'image') return 'square';
        if (t === 'video') return 'square';
        if (t === 'code') return 'square';
        if (t === 'link') return 'triangle';
        if (t === 'page') return 'hex';
        return 'circle';
      },
      shortLabel,
    });
  }, [data, collectionById]);

  // Recolour in place when the user flips the color mode. Same object
  // references, just a different `color` property — no simulation reset.
  useEffect(() => {
    if (!canvasData || !data) return;
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    for (const cn of canvasData.nodes) {
      if (cn.isHub) continue;
      const raw = byId.get(cn.id);
      if (!raw) continue;
      cn.color = pickColor(raw, colorMode, collectionById);
    }
  }, [colorMode, canvasData, data, collectionById]);

  const stats = data && {
    nodes: data.nodes.length,
    edges: data.edges.length,
    collections: data.collections.length,
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-800 bg-neutral-950 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Graph Explorer</h1>
            <p className="mt-0.5 text-xs text-neutral-500">
              Drag a domain group to move all its memories together. Drag a single
              memory and its neighbours drift along.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => {
                if (
                  window.confirm(
                    'Walk your captured memories and (re)build hierarchy edges? ' +
                      'Creates page parents, navigated_from links and same-session links. ' +
                      'Cheap, idempotent, no LLM cost.',
                  )
                ) {
                  backfill.mutate();
                }
              }}
              disabled={backfill.isPending}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
              title="Build hierarchy edges for nodes captured before this feature shipped"
            >
              {backfill.isPending ? 'Linking…' : '🕸 Backfill links'}
            </button>
            <div className="flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900 p-0.5 text-xs">
              <span className="px-2 text-neutral-500">Color by</span>
              {(['type', 'collection', 'site'] as ColorMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setColorMode(m)}
                  className={`rounded px-2 py-1 capitalize transition ${
                    colorMode === m
                      ? 'bg-neutral-800 text-neutral-100'
                      : 'text-neutral-400 hover:text-neutral-200'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            {stats && (
              <div className="flex gap-4 text-xs text-neutral-400">
                <span>
                  <strong className="text-neutral-200">{stats.nodes}</strong> nodes
                </span>
                <span>
                  <strong className="text-neutral-200">{stats.edges}</strong> edges
                </span>
                <span>
                  <strong className="text-neutral-200">{stats.collections}</strong> collections
                </span>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        <div className="relative h-full flex-1 bg-neutral-950">
          {canvasData && (
            <ForceGraphCanvas
              nodes={canvasData.nodes}
              links={canvasData.links}
              membersByHub={canvasData.membersByHub}
              lineageKeep={lineageKeep}
              selectedId={selected?.id ?? null}
              onSelect={(cn: CanvasNode) => {
                if (cn.isHub) return;
                if (cn.raw) setSelected(cn.raw);
              }}
              onBackgroundClick={() => setSelected(null)}
            />
          )}
        </div>

        {isLoading && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-3">
              <div className="relative">
                <Skeleton w={64} h={64} rounded="full" />
                <Skeleton w={28} h={28} rounded="full" className="absolute -right-10 top-2" />
                <Skeleton w={20} h={20} rounded="full" className="absolute -left-8 bottom-1" />
              </div>
              <Skeleton w={100} h={10} rounded="sm" />
            </div>
          </div>
        )}

        {selected && (
          <SidePanel
            node={selected}
            collections={(selected.collection_ids ?? [])
              .map((id) => collectionById.get(id))
              .filter((c): c is GraphCollection => !!c)}
            links={selectedLinks}
            onClose={() => setSelected(null)}
            onNavigate={(id) => {
              const n = nodeById.get(id);
              if (n) setSelected(n);
            }}
            onFocusLineage={(id) => setLineageFocus(id)}
          />
        )}
        {lineageFocus && (
          <div className="pointer-events-auto absolute right-4 top-4 z-20 flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/95 px-3 py-1.5 text-xs text-neutral-300 backdrop-blur">
            <span>Focused on lineage</span>
            <button
              onClick={() => setLineageFocus(null)}
              className="rounded bg-neutral-800 px-2 py-0.5 hover:bg-neutral-700"
            >
              Clear
            </button>
          </div>
        )}

        {data && (
          <Legend
            colorMode={colorMode}
            collections={data.collections}
            nodes={data.nodes}
          />
        )}
      </div>
    </div>
  );
}

function Legend({
  colorMode,
  collections,
  nodes,
}: {
  colorMode: ColorMode;
  collections: GraphCollection[];
  nodes: MockNode[];
}) {
  const items: Array<{ label: string; color: string }> = [];
  if (colorMode === 'type') {
    for (const t of Object.keys(TYPE_COLORS)) {
      items.push({ label: TYPE_LABELS[t] ?? t, color: TYPE_COLORS[t]! });
    }
  } else if (colorMode === 'collection') {
    for (const c of collections.slice(0, 12)) {
      items.push({ label: c.name, color: colorForCollection(c) });
    }
  } else {
    // site — pull the most common 10 sites from the loaded nodes
    const counts = new Map<string, number>();
    for (const n of nodes) {
      const k = siteKeyFor(n);
      if (!k) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const top = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [k] of top) {
      items.push({
        label: k,
        color:
          FALLBACK_PALETTE[hashIndex(k, FALLBACK_PALETTE.length)] ?? ORPHAN_COLOR,
      });
    }
  }

  return (
    <div className="pointer-events-none absolute bottom-4 left-4 hidden max-w-[220px] rounded-md border border-neutral-800 bg-neutral-950/90 p-3 text-xs backdrop-blur sm:block">
      <div className="mb-2 font-medium capitalize text-neutral-300">
        {colorMode}
      </div>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.label} className="flex items-center gap-2 text-neutral-400">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: it.color }}
            />
            <span className="truncate">{it.label}</span>
          </li>
        ))}
        {items.length === 0 && (
          <li className="text-neutral-600">No data yet.</li>
        )}
      </ul>
      <div className="mt-3 border-t border-neutral-800 pt-2 text-neutral-500">
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm border"
            style={{ borderColor: HUB_COLOR, background: HUB_COLOR + '20' }}
          />
          Source group (drag to move all)
        </div>
      </div>
      <div className="mt-3 border-t border-neutral-800 pt-2">
        <div className="mb-1 font-medium text-neutral-300">Connections</div>
        <ul className="space-y-1">
          {(
            [
              ['belongs_to_page', 'page parent', '#a78bfa'],
              ['navigated_from', 'navigated from', '#fb923c'],
              ['same_session', 'same session', '#52525b'],
              ['mentions', 'mentions', '#22d3ee'],
              ['extends', 'extends', '#84cc16'],
              ['cites', 'cites', '#facc15'],
              ['contradicts', 'contradicts', '#f87171'],
              ['note_link', 'note ↔ note', '#f5b301'],
            ] as const
          ).map(([k, label, color]) => (
            <li key={k} className="flex items-center gap-2 text-neutral-400">
              <span
                className="inline-block h-[2px] w-4 rounded"
                style={{ background: color }}
              />
              <span>{label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface NodeLink {
  edgeId: string;
  direction: 'parent' | 'child' | 'related';
  relation: MockEdge['relation_type'];
  node: MockNode;
}

/* ---------------------------------------------------------- */
/*  Side panel — clean document-style + clickable meta badges  */
/* ---------------------------------------------------------- */

type MetaBadge = {
  key: string;
  label: string;
  icon: string;
  color: string;
  detail: () => JSX.Element;
};

function buildMetaBadges(
  node: MockNode,
  collections: GraphCollection[],
  links: NodeLink[],
): MetaBadge[] {
  const ex = node.metadata?.extracted;
  const aiSummary = (node.metadata?.ai_summary as string | undefined) ?? null;
  const out: MetaBadge[] = [];

  // AI summary badge — first so it's the most prominent. Only shown when
  // an LLM actually produced one (cleanup-capture.summary).
  if (aiSummary) {
    out.push({
      key: 'summary',
      label: 'AI summary',
      icon: '✨',
      color: '#f5b301',
      detail: () => (
        <div>
          <p className="text-sm leading-relaxed text-neutral-200">{aiSummary}</p>
          <p className="mt-3 text-[10px] uppercase tracking-widest text-neutral-600">
            generated by Mesh on capture
          </p>
        </div>
      ),
    });
  }

  if (ex?.author) {
    out.push({
      key: 'author',
      label: ex.author,
      icon: '✍️',
      color: '#a78bfa',
      detail: () => (
        <p className="text-sm text-neutral-300">
          Author detected from page metadata: <strong>{ex.author}</strong>
        </p>
      ),
    });
  }
  if (ex?.published_at) {
    out.push({
      key: 'published',
      label: ex.published_at.slice(0, 10),
      icon: '📅',
      color: '#34d399',
      detail: () => (
        <p className="text-sm text-neutral-300">Published on {ex.published_at}</p>
      ),
    });
  }
  if (ex?.lang) {
    out.push({
      key: 'lang',
      label: ex.lang,
      icon: '🌐',
      color: '#22d3ee',
      detail: () => (
        <p className="text-sm text-neutral-300">
          Language tag from the source page: {ex.lang}
        </p>
      ),
    });
  }
  if (ex?.reading_time_minutes != null) {
    out.push({
      key: 'reading',
      label: `~${ex.reading_time_minutes} min`,
      icon: '⏱',
      color: '#facc15',
      detail: () => (
        <p className="text-sm text-neutral-300">
          Reading time: ~{ex.reading_time_minutes} minutes
          {ex.word_count ? ` (${ex.word_count.toLocaleString()} words)` : ''}
        </p>
      ),
    });
  }
  if (ex?.site_name ?? node.source_app) {
    const site = ex?.site_name ?? node.source_app!;
    out.push({
      key: 'site',
      label: site,
      icon: '🏷',
      color: '#60a5fa',
      detail: () => (
        <p className="text-sm text-neutral-300">
          Captured from <strong>{site}</strong>
          {node.source_url ? (
            <>
              {' '}
              —{' '}
              <a
                href={node.source_url}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                open URL ↗
              </a>
            </>
          ) : null}
        </p>
      ),
    });
  }
  if (ex?.keywords && ex.keywords.length > 0) {
    out.push({
      key: 'keywords',
      label: `${ex.keywords.length} keywords`,
      icon: '🔖',
      color: '#f472b6',
      detail: () => (
        <div className="flex flex-wrap gap-1.5">
          {(ex.keywords ?? []).map((k) => (
            <span
              key={k}
              className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-300"
            >
              {k}
            </span>
          ))}
        </div>
      ),
    });
  }
  if (node.entities?.length) {
    out.push({
      key: 'entities',
      label: `${node.entities.length} entities`,
      icon: '🧩',
      color: '#84cc16',
      detail: () => (
        <ul className="space-y-1 text-xs text-neutral-300">
          {node.entities.map((e, i) => (
            <li key={i} className="flex justify-between border-b border-neutral-900 py-1">
              <span>{e.value}</span>
              <span className="text-neutral-500">{e.type}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }
  if (collections.length > 0) {
    out.push({
      key: 'collections',
      label: `${collections.length} collection${collections.length > 1 ? 's' : ''}`,
      icon: '📚',
      color: '#fb923c',
      detail: () => (
        <ul className="space-y-1.5">
          {collections.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-sm text-neutral-300">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: colorForCollection(c) }}
              />
              {c.icon ? `${c.icon} ` : ''}
              {c.name}
            </li>
          ))}
        </ul>
      ),
    });
  }
  if (links.length > 0) {
    const parents = links.filter((l) => l.direction === 'parent').length;
    const children = links.filter((l) => l.direction === 'child').length;
    const related = links.length - parents - children;
    out.push({
      key: 'links',
      label: `${links.length} connection${links.length > 1 ? 's' : ''}`,
      icon: '🔗',
      color: '#22d3ee',
      detail: () => (
        <div>
          <p className="mb-2 text-xs text-neutral-500">
            {parents} parent{parents !== 1 ? 's' : ''} · {children} child
            {children !== 1 ? 'ren' : ''} · {related} related
          </p>
          <ul className="space-y-1.5">
            {links.map((l) => (
              <li key={l.edgeId} className="flex items-center gap-2 text-xs">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: RELATION_COLOR[l.relation] ?? '#52525b' }}
                />
                <span className="uppercase tracking-wider text-neutral-500">
                  {l.direction}
                </span>
                <span className="text-neutral-300">
                  {l.relation.replace(/_/g, ' ')} —{' '}
                  {l.node.metadata?.extracted?.title ??
                    l.node.summary ??
                    l.node.content.slice(0, 60)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ),
    });
  }
  out.push({
    key: 'captured',
    label: formatDistanceToNow(
      new Date(
        ex?.source_extracted_at ??
          (node.metadata?.capturedAt as string | undefined) ??
          node.created_at,
      ),
      { addSuffix: true },
    ),
    icon: '🕐',
    color: '#737373',
    detail: () => (
      <p className="text-sm text-neutral-300">
        Captured on{' '}
        {format(
          new Date(
            ex?.source_extracted_at ??
              (node.metadata?.capturedAt as string | undefined) ??
              node.created_at,
          ),
          'MMM d, yyyy · HH:mm:ss',
        )}
      </p>
    ),
  });
  return out;
}

function SidePanel({
  node,
  collections,
  links,
  onClose,
  onNavigate,
  onFocusLineage,
}: {
  node: MockNode;
  collections: GraphCollection[];
  links: NodeLink[];
  onClose: () => void;
  onNavigate: (id: string) => void;
  onFocusLineage: (id: string) => void;
}) {
  const ex = node.metadata?.extracted;
  const nodeType = effectiveNodeType(node);
  const typeColor = TYPE_COLORS[nodeType] ?? ORPHAN_COLOR;
  const title =
    ex?.title ??
    (node.metadata?.pageTitle as string | undefined) ??
    node.summary?.split(/[.\n]/)[0] ??
    'Untitled';
  const description = ex?.description ?? null;
  const body = ex?.content ?? node.content;
  const mediaUrl = ex?.media_url ?? (node.metadata?.mediaUrl as string | undefined);
  const thumb = ex?.media_thumbnail ?? null;

  const badges = buildMetaBadges(node, collections, links);
  const [openBadge, setOpenBadge] = useState<MetaBadge | null>(null);

  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-full max-w-[90vw] flex-col border-l border-neutral-800 bg-neutral-950/95 backdrop-blur sm:w-[460px]">
      <div className="flex items-center justify-between border-b border-neutral-900 px-5 py-3 text-xs text-neutral-500">
        <button
          onClick={() => onFocusLineage(node.id)}
          className="hover:text-neutral-200"
          title="Focus on this node's ancestors and descendants"
        >
          ↟ Focus lineage
        </button>
        <button onClick={onClose} className="hover:text-neutral-200">
          ✕
        </button>
      </div>

      <article className="flex-1 overflow-y-auto px-6 py-6">
        <div
          className="mb-3 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest"
          style={{
            background: typeColor + '22',
            color: typeColor,
            border: `1px solid ${typeColor}44`,
          }}
        >
          {TYPE_LABELS[nodeType] ?? nodeType}
        </div>

        <h1 className="mb-3 text-xl font-semibold leading-tight text-neutral-100">
          {title}
        </h1>

        {(ex?.author || ex?.site_name) && (
          <p className="mb-5 text-sm text-neutral-500">
            {ex?.author && <span>by {ex.author}</span>}
            {ex?.author && (ex?.site_name || node.source_app) && <span> · </span>}
            {(ex?.site_name || node.source_app) && (
              <span>{ex?.site_name ?? node.source_app}</span>
            )}
          </p>
        )}

        {(nodeType === 'image' || nodeType === 'page') && (mediaUrl || thumb) && (
          <div className="mb-5 overflow-hidden rounded-lg border border-neutral-800">
            <img
              src={mediaUrl ?? thumb ?? ''}
              alt={title}
              className="block h-auto max-h-80 w-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          </div>
        )}
        {nodeType === 'video' && mediaUrl && (
          <video
            src={mediaUrl}
            poster={thumb ?? undefined}
            controls
            preload="metadata"
            className="mb-5 block h-auto max-h-80 w-full rounded-lg border border-neutral-800"
          />
        )}

        {description && (
          <p className="mb-5 text-base leading-relaxed text-neutral-300">{description}</p>
        )}

        {body && body !== description && (
          <BodyContent text={body} isCode={nodeType === 'code'} />
        )}

        {node.source_url && (
          <p className="mt-6 border-t border-neutral-900 pt-4 text-xs">
            <a
              href={node.source_url}
              target="_blank"
              rel="noreferrer"
              className="text-neutral-500 hover:text-accent"
            >
              ↗{' '}
              {(() => {
                try {
                  const u = new URL(node.source_url!);
                  return u.hostname + u.pathname.slice(0, 40);
                } catch {
                  return node.source_url;
                }
              })()}
            </a>
          </p>
        )}

        {badges.length > 0 && (
          <div className="mt-6 flex flex-wrap gap-1.5 border-t border-neutral-900 pt-5">
            {badges.map((b) => (
              <button
                key={b.key}
                onClick={() => setOpenBadge(b)}
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition hover:brightness-125"
                style={{
                  background: b.color + '14',
                  color: b.color,
                  borderColor: b.color + '40',
                }}
              >
                <span>{b.icon}</span>
                <span className="font-medium">{b.label}</span>
              </button>
            ))}
          </div>
        )}

        {node.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {node.tags.map((t, i) => (
              <span
                key={i}
                className="rounded-full border border-neutral-800 px-2 py-0.5 text-[10px] text-neutral-500"
              >
                #{t}
              </span>
            ))}
          </div>
        )}

        {links.length > 0 && (
          <div className="mt-6 border-t border-neutral-900 pt-5">
            <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
              Connections
            </div>
            <ul className="space-y-1.5">
              {links.slice(0, 8).map((l) => (
                <li key={l.edgeId}>
                  <button
                    onClick={() => onNavigate(l.node.id)}
                    className="group flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-neutral-900/60"
                  >
                    <span
                      className="inline-block h-1.5 w-1.5 flex-none rounded-full"
                      style={{ background: RELATION_COLOR[l.relation] ?? '#52525b' }}
                    />
                    <span className="w-12 flex-none text-[9px] uppercase tracking-wider text-neutral-600">
                      {l.direction}
                    </span>
                    <span className="truncate text-neutral-300 group-hover:text-neutral-100">
                      {l.node.metadata?.extracted?.title ??
                        l.node.summary ??
                        l.node.content.slice(0, 60)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </article>

      {openBadge && (
        <div
          className="absolute inset-0 z-20 grid place-items-center bg-black/60 backdrop-blur-sm"
          onClick={() => setOpenBadge(null)}
        >
          <div
            className="w-[88%] max-w-md rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-neutral-900 px-4 py-3">
              <div
                className="inline-flex items-center gap-2 text-sm font-medium"
                style={{ color: openBadge.color }}
              >
                <span>{openBadge.icon}</span>
                <span>{openBadge.label}</span>
              </div>
              <button
                onClick={() => setOpenBadge(null)}
                className="text-neutral-500 hover:text-neutral-200"
              >
                ✕
              </button>
            </header>
            <div className="max-h-[60vh] overflow-y-auto px-4 py-4">
              {openBadge.detail()}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function BodyContent({ text, isCode }: { text: string; isCode: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 700;
  const display = !long || expanded ? text : text.slice(0, 700) + '…';
  if (isCode) {
    return (
      <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-[12px] leading-relaxed text-neutral-300">
        <code>{display}</code>
      </pre>
    );
  }
  return (
    <div className="max-w-none">
      <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-neutral-200">
        {display}
      </p>
      {long && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-xs text-accent hover:underline"
        >
          {expanded ? 'Show less' : `Show all (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

void {} as MockEdge | undefined;
