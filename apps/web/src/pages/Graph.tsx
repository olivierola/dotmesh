import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { useQuery } from '@tanstack/react-query';
import { format, formatDistanceToNow } from 'date-fns';
import { api, type GraphCollection } from '@/lib/api-client';
import type { MockNode, MockEdge } from '@/lib/mock';
import { Skeleton } from '@/components/Skeleton';

cytoscape.use(fcose);

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

function nodeColor(node: MockNode): string {
  const t = effectiveNodeType(node);
  return TYPE_COLORS[t] ?? ORPHAN_COLOR;
}

function nodeShape(node: MockNode): string {
  const t = effectiveNodeType(node);
  if (t === 'image') return 'round-rectangle';
  if (t === 'video') return 'cut-rectangle';
  if (t === 'code') return 'round-diamond';
  if (t === 'link') return 'round-triangle';
  if (t === 'page') return 'round-octagon';
  if (t === 'quote') return 'round-pentagon';
  if (t === 'action') return 'star';
  return 'ellipse';
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
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [selected, setSelected] = useState<MockNode | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['graph'],
    queryFn: () => api.loadGraph(),
  });

  const collectionById = useMemo(() => {
    const m = new Map<string, GraphCollection>();
    for (const c of data?.collections ?? []) m.set(c.id, c);
    return m;
  }, [data?.collections]);

  useEffect(() => {
    if (!data || !containerRef.current) return;

    const realNodes = data.nodes;
    const nodesById = new Map(realNodes.map((n) => [n.id, n]));

    // Build hub nodes per source domain. Create a hub even with 1 member
    // so that orphan nodes still get visual grouping by source.
    const hubMembers = new Map<string, string[]>();
    for (const n of realNodes) {
      const k = hubKey(n);
      if (!k) continue;
      const arr = hubMembers.get(k) ?? [];
      arr.push(n.id);
      hubMembers.set(k, arr);
    }

    const hubElements: ElementDefinition[] = [];
    const hubEdges: ElementDefinition[] = [];
    for (const [key, members] of hubMembers) {
      if (members.length < 1) continue;
      const hubId = `hub:${key}`;
      hubElements.push({
        data: {
          id: hubId,
          label: hubLabel(key),
          color: HUB_COLOR,
          shape: 'hexagon',
          isHub: true,
          degree: members.length,
        },
      });
      for (const nid of members) {
        hubEdges.push({
          data: {
            id: `${hubId}->${nid}`,
            source: hubId,
            target: nid,
            relation: 'origin',
            confidence: 0.4,
            label: '',
            isHubEdge: true,
          },
        });
      }
    }

    const elements: ElementDefinition[] = [
      ...realNodes.map((n) => ({
        data: {
          id: n.id,
          label: shortLabel(n),
          color: nodeColor(n),
          shape: nodeShape(n),
          source: n.source,
          nodeType: effectiveNodeType(n),
          isHub: false,
        },
      })),
      ...hubElements,
      ...data.edges
        .filter((e) => nodesById.has(e.from_node) && nodesById.has(e.to_node))
        .map((e) => ({
          data: {
            id: e.id,
            source: e.from_node,
            target: e.to_node,
            relation: e.relation_type,
            confidence: e.confidence,
            label: e.shared_entity ?? '',
            isHubEdge: false,
          },
        })),
      ...hubEdges,
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            // @ts-expect-error data() for shape works at runtime
            shape: 'data(shape)',
            'border-color': '#0a0a0a',
            'border-width': 2,
            label: 'data(label)',
            color: '#e5e5e5',
            'font-size': 9,
            'font-weight': 500,
            'font-family': 'Inter, system-ui, sans-serif',
            'text-wrap': 'ellipsis',
            'text-max-width': '110px',
            'text-valign': 'bottom',
            'text-halign': 'center',
            'text-margin-y': 6,
            'text-background-color': '#0a0a0a',
            'text-background-opacity': 0.75,
            'text-background-padding': '3px',
            'text-background-shape': 'roundrectangle',
            'text-events': 'no',
            'min-zoomed-font-size': 8,
            width: 18,
            height: 18,
          },
        },
        {
          selector: 'node[isHub]',
          style: {
            'background-color': HUB_COLOR,
            'border-color': '#fef3c7',
            'border-width': 3,
            'font-size': 13,
            'font-weight': 700,
            color: '#fde68a',
            width: 'mapData(degree, 2, 30, 38, 80)',
            height: 'mapData(degree, 2, 30, 38, 80)',
            'text-margin-y': 10,
          },
        },
        {
          selector: 'node:selected',
          style: { 'border-color': '#f5b301', 'border-width': 4 },
        },
        {
          selector: 'edge',
          style: {
            width: 'mapData(confidence, 0, 1, 0.5, 2.5)',
            'line-color': '#3f3f46',
            'curve-style': 'bezier',
            opacity: 0.6,
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#3f3f46',
            'arrow-scale': 0.6,
          },
        },
        {
          selector: 'edge[isHubEdge]',
          style: {
            'line-color': '#52525b',
            'line-style': 'dashed',
            'target-arrow-shape': 'none',
            opacity: 0.4,
            width: 1,
          },
        },
        {
          selector: 'edge[relation = "contradicts"]',
          style: { 'line-color': '#f87171', 'target-arrow-color': '#f87171' },
        },
        {
          selector: 'edge[relation = "supersedes"]',
          style: { 'line-color': '#34d399', 'target-arrow-color': '#34d399' },
        },
        {
          selector: 'edge:selected',
          style: { 'line-color': '#f5b301', 'target-arrow-color': '#f5b301', opacity: 1 },
        },
      ],
      layout: {
        name: 'fcose',
        // @ts-expect-error fcose options not in core types
        quality: 'proof',
        animate: false,
        randomize: true,
        nodeRepulsion: 45000,
        idealEdgeLength: 180,
        edgeElasticity: 0.3,
        gravity: 0.1,
        gravityRange: 2.5,
        padding: 60,
        nodeSeparation: 220,
        nodeOverlap: 30,
        uniformNodeDimensions: false,
        tile: false,
        fit: true,
      },
      wheelSensitivity: 0.2,
      minZoom: 0.2,
      maxZoom: 3,
    });

    cy.on('tap', 'node', (evt) => {
      const id = evt.target.id() as string;
      if (id.startsWith('hub:')) {
        // Clicking a hub focuses its cluster — center + zoom
        const neighbors = evt.target.neighborhood();
        cy.animate({ fit: { eles: evt.target.union(neighbors), padding: 60 }, duration: 380 });
        setSelected(null);
        return;
      }
      setSelected(nodesById.get(id) ?? null);
    });
    cy.on('tap', (evt) => {
      if (evt.target === cy) setSelected(null);
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [data, collectionById]);

  const stats = data && {
    nodes: data.nodes.length,
    edges: data.edges.length,
    collections: data.collections.length,
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-800 bg-neutral-950 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Graph Explorer</h1>
            <p className="mt-0.5 text-xs text-neutral-500">
              Hexagons = source hubs. Color &amp; shape = entry type. Click a node for details.
            </p>
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
      </header>

      <div className="relative flex flex-1 overflow-hidden">
        <div ref={containerRef} className="flex-1 bg-neutral-950" />

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
            onClose={() => setSelected(null)}
          />
        )}

        {data && (
          <div className="pointer-events-none absolute bottom-4 left-4 hidden max-w-[220px] rounded-md border border-neutral-800 bg-neutral-950/90 p-3 text-xs backdrop-blur sm:block">
            <div className="mb-2 font-medium text-neutral-300">Entry type</div>
            <ul className="space-y-1">
              {Object.keys(TYPE_COLORS).map((t) => (
                <li key={t} className="flex items-center gap-2 text-neutral-400">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: TYPE_COLORS[t] }}
                  />
                  <span>{TYPE_LABELS[t] ?? t}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-neutral-800 pt-2 text-neutral-500">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2"
                  style={{
                    background: HUB_COLOR,
                    clipPath:
                      'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
                  }}
                />
                Source hub
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SidePanel({
  node,
  collections,
  onClose,
}: {
  node: MockNode;
  collections: GraphCollection[];
  onClose: () => void;
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
