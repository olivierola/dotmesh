import { useEffect, useRef, useState } from 'react';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import type { MockNode, MockEdge } from '@/lib/mock';
import { Skeleton } from '@/components/Skeleton';

cytoscape.use(fcose);

const SOURCE_COLORS: Record<string, string> = {
  extension: '#60a5fa',
  manual: '#a78bfa',
  mcp: '#34d399',
  'connector:gmail': '#f87171',
  'connector:slack': '#fbbf24',
  'connector:gcal': '#22d3ee',
  'connector:notion': '#e5e5e5',
};

function colorFor(source: string): string {
  return SOURCE_COLORS[source] ?? '#737373';
}

export default function GraphPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [selected, setSelected] = useState<MockNode | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['graph'],
    queryFn: () => api.loadGraph(),
  });

  useEffect(() => {
    if (!data || !containerRef.current) return;

    const nodesById = new Map(data.nodes.map((n) => [n.id, n]));

    const elements: ElementDefinition[] = [
      ...data.nodes.map((n) => ({
        data: {
          id: n.id,
          label: (n.summary ?? n.content).slice(0, 60),
          color: colorFor(n.source),
          source: n.source,
        },
      })),
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
          },
        })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'border-color': '#0a0a0a',
            'border-width': 2,
            label: 'data(label)',
            color: '#e5e5e5',
            'font-size': 9,
            'font-family': 'Inter, system-ui, sans-serif',
            'text-wrap': 'wrap',
            'text-max-width': '120px',
            'text-valign': 'bottom',
            'text-margin-y': 6,
            width: 'mapData(degree, 0, 10, 18, 56)',
            height: 'mapData(degree, 0, 10, 18, 56)',
          },
        },
        {
          selector: 'node:selected',
          style: { 'border-color': '#f5b301', 'border-width': 3 },
        },
        {
          selector: 'edge',
          style: {
            width: 'mapData(confidence, 0, 1, 0.5, 3)',
            'line-color': '#3f3f46',
            'curve-style': 'bezier',
            opacity: 0.7,
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#3f3f46',
            'arrow-scale': 0.7,
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
          style: { 'line-color': '#f5b301', 'target-arrow-color': '#f5b301' },
        },
      ],
      layout: {
        name: 'fcose',
        // @ts-expect-error fcose options not in core types
        quality: 'default',
        animate: false,
        nodeRepulsion: 6000,
        idealEdgeLength: 90,
        gravity: 0.2,
        padding: 30,
      },
      wheelSensitivity: 0.2,
      minZoom: 0.3,
      maxZoom: 3,
    });

    cy.on('tap', 'node', (evt) => {
      const id = evt.target.id() as string;
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
  }, [data]);

  const stats = data && {
    nodes: data.nodes.length,
    edges: data.edges.length,
    sources: new Set(data.nodes.map((n) => n.source)).size,
  };

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-neutral-800 bg-neutral-950 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Graph Explorer</h1>
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
                <strong className="text-neutral-200">{stats.sources}</strong> sources
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
                <Skeleton
                  w={28}
                  h={28}
                  rounded="full"
                  className="absolute -right-10 top-2"
                />
                <Skeleton
                  w={20}
                  h={20}
                  rounded="full"
                  className="absolute -left-8 bottom-1"
                />
              </div>
              <Skeleton w={100} h={10} rounded="sm" />
            </div>
          </div>
        )}

        {selected && <SidePanel node={selected} onClose={() => setSelected(null)} />}

        {/* Legend */}
        <div className="pointer-events-none absolute bottom-4 left-4 hidden rounded-md border border-neutral-800 bg-neutral-950/90 p-3 text-xs backdrop-blur sm:block">
          <div className="mb-2 font-medium text-neutral-300">Sources</div>
          {Object.entries(SOURCE_COLORS).map(([src, col]) => (
            <div key={src} className="flex items-center gap-2 text-neutral-400">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: col }}
              />
              {src}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SidePanel({ node, onClose }: { node: MockNode; onClose: () => void }) {
  return (
    <aside className="absolute right-0 top-0 z-10 flex h-full w-full max-w-[90vw] flex-col border-l border-neutral-800 bg-neutral-950/95 backdrop-blur sm:w-80">
      <div className="flex items-center justify-between border-b border-neutral-800 p-4">
        <div className="text-xs uppercase tracking-widest text-neutral-500">{node.source}</div>
        <button
          onClick={onClose}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 text-sm">
        <p className="mb-3 text-neutral-200">{node.summary ?? node.content.slice(0, 240)}</p>
        <p className="mb-4 text-xs text-neutral-500">
          {formatDistanceToNow(new Date(node.created_at), { addSuffix: true })}
        </p>

        {node.entities.length > 0 && (
          <div className="mb-4">
            <div className="mb-1.5 text-xs uppercase tracking-widest text-neutral-500">
              Entities
            </div>
            <div className="flex flex-wrap gap-1">
              {node.entities.map((e, i) => (
                <span
                  key={i}
                  className="rounded-full bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300"
                >
                  {e.value}
                </span>
              ))}
            </div>
          </div>
        )}

        {node.tags.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-widest text-neutral-500">Tags</div>
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

        {node.source_url && (
          <a
            href={node.source_url}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-block text-xs text-accent hover:underline"
          >
            Open source ↗
          </a>
        )}
      </div>
    </aside>
  );
}

// Keep the unused import shut up
void {} as MockEdge | undefined;
