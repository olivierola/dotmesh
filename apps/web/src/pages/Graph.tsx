import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { api, type GraphCollection } from '@/lib/api-client';
import type { MockNode, MockEdge } from '@/lib/mock';
import { Skeleton } from '@/components/Skeleton';
import ForceGraphCanvas, {
  buildCanvasData,
  type CanvasNode,
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
};

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
    return buildCanvasData({
      nodes: data.nodes,
      edges: data.edges,
      hubMembers,
      hubLabel,
      hubKey,
      hubColor: HUB_COLOR,
      // Initial colour: 'type' mode. Subsequent changes mutate `color` on
      // the existing node objects (see effect below) without recreating
      // anything, so positions survive.
      pickNodeColor: (n) => pickColor(n, 'type', collectionById),
      pickNodeShape: (n) => {
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
  const extracted = node.metadata?.extracted;
  const nodeType = effectiveNodeType(node);
  const elType = node.metadata?.elementType ?? nodeType;
  const mediaUrl = extracted?.media_url ?? (node.metadata?.mediaUrl as string | undefined);
  const thumb = extracted?.media_thumbnail ?? null;
  const captureType = node.metadata?.captureType;
  const capturedAt =
    extracted?.source_extracted_at ??
    (node.metadata?.capturedAt as string | undefined) ??
    node.created_at;
  const dateObj = new Date(capturedAt);
  const surroundingContext = node.metadata?.surroundingContext as string | undefined;
  const heading = node.metadata?.heading as string | undefined;
  const author = extracted?.author ?? (node.metadata?.author as string | undefined);
  const pageTitle =
    extracted?.title ?? (node.metadata?.pageTitle as string | undefined);
  const reason = node.metadata?.reason as string | undefined;
  const description = extracted?.description ?? null;
  const siteName = extracted?.site_name ?? node.source_app ?? null;
  const lang = extracted?.lang ?? null;
  const publishedAt = extracted?.published_at ?? null;
  const extractedKeywords = extracted?.keywords ?? [];
  const extractedActions = extracted?.actions ?? [];
  const extractionMethod = extracted?.extraction_method ?? null;

  // Strip the leading [tag] from the content (e.g., "[Image] https://...") for display
  const cleanContent = (node.content ?? '').replace(/^\[[^\]]+\]\s*/, '');

  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-full max-w-[90vw] flex-col border-l border-neutral-800 bg-neutral-950/95 backdrop-blur sm:w-[420px]">
      <div className="flex items-center justify-between border-b border-neutral-800 p-4">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span
            className="rounded px-2 py-0.5 font-medium"
            style={{
              background: (TYPE_COLORS[nodeType] ?? ORPHAN_COLOR) + '22',
              color: TYPE_COLORS[nodeType] ?? '#a3a3a3',
            }}
          >
            {TYPE_LABELS[nodeType] ?? nodeType}
          </span>
          {captureType && (
            <span className="rounded bg-amber-500/10 px-2 py-0.5 text-amber-300">
              {captureType}
            </span>
          )}
          {elType && elType !== nodeType && (
            <span className="rounded border border-neutral-800 px-2 py-0.5 text-neutral-400">
              {elType}
            </span>
          )}
          {extractionMethod && (
            <span
              className="rounded border border-neutral-800 px-2 py-0.5 text-neutral-500"
              title="How metadata was obtained"
            >
              {extractionMethod}
            </span>
          )}
          {reason && (
            <span className="rounded border border-neutral-800 px-2 py-0.5 text-neutral-500">
              {reason}
            </span>
          )}
          <span className="text-neutral-500">{node.source}</span>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 text-sm">
        {/* Title from extracted */}
        {pageTitle && (
          <h2 className="mb-2 text-base font-semibold leading-snug text-neutral-100">
            {pageTitle}
          </h2>
        )}
        {description && (
          <p className="mb-4 text-sm text-neutral-300">{description}</p>
        )}

        {/* Media preview */}
        {(nodeType === 'image' || elType === 'image') && (mediaUrl || thumb) && (
          <div className="mb-4 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900">
            <img
              src={mediaUrl ?? thumb ?? ''}
              alt={pageTitle ?? node.summary ?? ''}
              className="block h-auto max-h-80 w-full object-contain"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          </div>
        )}
        {(nodeType === 'video' || elType === 'video') && mediaUrl && (
          <div className="mb-4 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900">
            <video
              src={mediaUrl}
              poster={thumb ?? undefined}
              controls
              className="block h-auto max-h-80 w-full"
              preload="metadata"
            />
          </div>
        )}
        {nodeType === 'code' && (
          <pre className="mb-4 max-h-72 overflow-auto rounded-md border border-neutral-800 bg-neutral-900 p-3 text-[11px] leading-relaxed text-neutral-300">
            <code>{extracted?.content ?? cleanContent}</code>
          </pre>
        )}

        {/* Summary */}
        {node.summary && node.summary !== description && (
          <div className="mb-4">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-neutral-500">
              Summary
            </div>
            <p className="whitespace-pre-wrap text-neutral-200">{node.summary}</p>
          </div>
        )}

        {/* Full content (collapsed for long ones) */}
        {elType !== 'code' && cleanContent && (
          <FullContent text={cleanContent} />
        )}

        {/* Heading / author from metadata */}
        {(heading || author) && (
          <div className="mb-4 rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-xs">
            {heading && <div className="text-neutral-300">{heading}</div>}
            {author && <div className="mt-1 text-neutral-500">By {author}</div>}
          </div>
        )}

        {/* Surrounding context (for images/videos) */}
        {surroundingContext && (
          <div className="mb-4">
            <div className="mb-1 text-[10px] uppercase tracking-widest text-neutral-500">
              Context around
            </div>
            <p className="rounded-md border border-neutral-800 bg-neutral-900/30 p-2 text-xs text-neutral-400">
              {surroundingContext}
            </p>
          </div>
        )}

        {/* Metadata: date + url + extracted fields */}
        <div className="mb-4 space-y-1.5 rounded-md border border-neutral-800 bg-neutral-900/30 p-3 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-neutral-500">Captured</span>
            <span className="text-right text-neutral-300">
              {format(dateObj, 'MMM d, yyyy · HH:mm:ss')}
              <span className="ml-1 text-neutral-500">
                ({formatDistanceToNow(dateObj, { addSuffix: true })})
              </span>
            </span>
          </div>
          {author && (
            <div className="flex justify-between gap-3">
              <span className="text-neutral-500">Author</span>
              <span className="text-right text-neutral-200">{author}</span>
            </div>
          )}
          {publishedAt && (
            <div className="flex justify-between gap-3">
              <span className="text-neutral-500">Published</span>
              <span className="text-right text-neutral-300">{publishedAt}</span>
            </div>
          )}
          {lang && (
            <div className="flex justify-between gap-3">
              <span className="text-neutral-500">Language</span>
              <span className="text-right text-neutral-300">{lang}</span>
            </div>
          )}
          {extracted?.reading_time_minutes != null && (
            <div className="flex justify-between gap-3">
              <span className="text-neutral-500">Reading time</span>
              <span className="text-right text-neutral-300">
                ~{extracted.reading_time_minutes} min
                {extracted.word_count
                  ? ` · ${extracted.word_count.toLocaleString()} words`
                  : ''}
              </span>
            </div>
          )}
          {extracted?.canonical_url &&
            extracted.canonical_url !== node.source_url && (
              <div className="flex justify-between gap-3">
                <span className="text-neutral-500">Canonical</span>
                <a
                  href={extracted.canonical_url}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-right text-accent hover:underline"
                  title={extracted.canonical_url}
                >
                  {(() => {
                    try {
                      const u = new URL(extracted.canonical_url!);
                      return u.hostname + u.pathname.slice(0, 30);
                    } catch {
                      return extracted.canonical_url;
                    }
                  })()}
                </a>
              </div>
            )}
          {siteName && (
            <div className="flex justify-between gap-3">
              <span className="text-neutral-500">Source app</span>
              <span className="text-neutral-300">{siteName}</span>
            </div>
          )}
          {node.source_url && (
            <div className="flex justify-between gap-3">
              <span className="text-neutral-500">URL</span>
              <a
                href={node.source_url}
                target="_blank"
                rel="noreferrer"
                className="truncate text-right text-accent hover:underline"
                title={node.source_url}
              >
                {(() => {
                  try {
                    const u = new URL(node.source_url!);
                    return u.hostname + u.pathname.slice(0, 30);
                  } catch {
                    return node.source_url;
                  }
                })()}
              </a>
            </div>
          )}
          {typeof node.score === 'number' && (
            <div className="flex justify-between gap-3">
              <span className="text-neutral-500">Score</span>
              <span className="text-neutral-300">{node.score.toFixed(2)}</span>
            </div>
          )}
        </div>

        {/* Collections */}
        {collections.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-[10px] uppercase tracking-widest text-neutral-500">
              Collections
            </div>
            <div className="flex flex-wrap gap-1.5">
              {collections.map((c) => (
                <span
                  key={c.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300"
                >
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: colorForCollection(c) }}
                  />
                  {c.icon ? `${c.icon} ` : ''}
                  {c.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Entities */}
        {node.entities.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-[10px] uppercase tracking-widest text-neutral-500">
              Entities ({node.entities.length})
            </div>
            <div className="flex flex-wrap gap-1">
              {node.entities.map((e, i) => (
                <span
                  key={i}
                  className="rounded-full bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300"
                  title={e.type}
                >
                  {e.value}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Keywords from extracted */}
        {extractedKeywords.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-[10px] uppercase tracking-widest text-neutral-500">
              Keywords
            </div>
            <div className="flex flex-wrap gap-1">
              {extractedKeywords.map((k, i) => (
                <span
                  key={`${k}-${i}`}
                  className="rounded-full border border-neutral-800 bg-neutral-900/60 px-2 py-0.5 text-[11px] text-neutral-300"
                >
                  {k}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* User / system actions on this node */}
        {extractedActions.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-[10px] uppercase tracking-widest text-neutral-500">
              Actions
            </div>
            <ul className="space-y-1 text-[11px] text-neutral-400">
              {extractedActions.slice(0, 6).map((a, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="text-neutral-300">{a.kind}</span>
                  <span className="text-neutral-500">
                    {a.value ? `${a.value} · ` : ''}
                    {a.at ? formatDistanceToNow(new Date(a.at), { addSuffix: true }) : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Connections */}
        {links.length > 0 && (
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-widest text-neutral-500">
                Connections ({links.length})
              </div>
              <button
                onClick={() => onFocusLineage(node.id)}
                className="text-[11px] text-accent hover:underline"
                title="Show only this node's ancestors and descendants"
              >
                Focus lineage
              </button>
            </div>
            <ul className="space-y-1.5">
              {links.map((l) => (
                <li key={l.edgeId}>
                  <button
                    onClick={() => onNavigate(l.node.id)}
                    className="group flex w-full items-start gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 p-2 text-left hover:border-neutral-700 hover:bg-neutral-900"
                  >
                    <span
                      className="mt-1 inline-block h-2 w-2 flex-none rounded-full"
                      style={{ background: RELATION_COLOR[l.relation] ?? '#52525b' }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
                        <span>{l.direction}</span>
                        <span className="text-neutral-700">·</span>
                        <span style={{ color: RELATION_COLOR[l.relation] ?? '#9ca3af' }}>
                          {l.relation.replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div className="truncate text-xs text-neutral-200 group-hover:text-neutral-100">
                        {l.node.metadata?.extracted?.title ??
                          l.node.summary ??
                          l.node.content.slice(0, 80)}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Tags */}
        {node.tags.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-[10px] uppercase tracking-widest text-neutral-500">Tags</div>
            <div className="flex flex-wrap gap-1">
              {node.tags.map((t, i) => (
                <span
                  key={i}
                  className="rounded-full border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-400"
                >
                  #{t}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function FullContent({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 400;
  const display = !long || expanded ? text : text.slice(0, 400) + '…';

  return (
    <div className="mb-4">
      <div className="mb-1 text-[10px] uppercase tracking-widest text-neutral-500">
        Content
      </div>
      <p className="whitespace-pre-wrap text-sm text-neutral-300">{display}</p>
      {long && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs text-accent hover:underline"
        >
          {expanded ? 'Show less' : `Show all (${text.length} chars)`}
        </button>
      )}
    </div>
  );
}

void {} as MockEdge | undefined;
