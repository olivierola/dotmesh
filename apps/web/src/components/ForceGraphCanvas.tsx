/**
 * Force-directed graph canvas backed by react-force-graph-2d.
 *
 * Replaces the Cytoscape canvas: nodes float continuously thanks to a live
 * d3-force simulation (much more "second-brain"-feeling than Cytoscape's
 * fcose snapshot layout).
 *
 * Behaviour:
 *   - drag a leaf node → it follows the cursor; connected neighbours drift
 *     toward it via the simulation's link force,
 *   - drag a hub → the hub's members are also dragged rigidly with the
 *     same delta (group drag, like before),
 *   - click a node → onSelect(node) bubbles up so the page can show the
 *     side panel,
 *   - lineageKeep restricts visibility to a subset of node ids,
 *   - colourMode / nodeColor are computed by the page and passed in.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { MockNode, MockEdge } from '@/lib/mock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FG: any = ForceGraph2D;

export interface CanvasNode {
  id: string;
  label: string;
  color: string;
  size: number;
  isHub: boolean;
  shape: 'circle' | 'hex' | 'square' | 'triangle';
  raw?: MockNode;
  // d3-force will mutate these at runtime:
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

export interface CanvasLink {
  id: string;
  source: string;
  target: string;
  relation: string;
  color: string;
  width: number;
  style: 'solid' | 'dashed' | 'dotted';
  isHubEdge: boolean;
}

export interface ForceGraphCanvasProps {
  nodes: CanvasNode[];
  links: CanvasLink[];
  /** Node ids to keep visible (others are dimmed). null = show all. */
  lineageKeep?: Set<string> | null;
  /** Map hubId → memberIds for rigid group-drag. */
  membersByHub?: Map<string, string[]>;
  onSelect?: (n: CanvasNode) => void;
  onBackgroundClick?: () => void;
  selectedId?: string | null;
}

function nodeRadius(n: CanvasNode): number {
  return n.isHub ? 14 + Math.min(n.size, 30) * 0.6 : 5 + Math.log(n.size + 1) * 1.2;
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  n: CanvasNode,
  r: number,
  dimmed: boolean,
): void {
  ctx.beginPath();
  ctx.fillStyle = dimmed ? n.color + '33' : n.color;
  ctx.strokeStyle = dimmed ? '#0a0a0a55' : '#0a0a0a';
  ctx.lineWidth = n.isHub ? 2 : 1.5;
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  if (n.shape === 'hex') {
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      const px = x + r * Math.cos(a);
      const py = y + r * Math.sin(a);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else if (n.shape === 'square') {
    ctx.rect(x - r, y - r, r * 2, r * 2);
  } else if (n.shape === 'triangle') {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.lineTo(x - r, y + r);
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
}

export default function ForceGraphCanvas({
  nodes,
  links,
  lineageKeep,
  membersByHub,
  onSelect,
  onBackgroundClick,
  selectedId,
}: ForceGraphCanvasProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const dragSeed = useRef<{ id: string; x: number; y: number } | null>(null);

  // Track container size for the canvas
  useEffect(() => {
    const update = () => {
      const r = containerRef.current?.getBoundingClientRect();
      if (r) setSize({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Configure simulation forces once we have the instance.
  useEffect(() => {
    const fg = ref.current;
    if (!fg) return;
    // Slightly stronger spring + a bit of charge for breathing room
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const linkForce: any = fg.d3Force('link');
    linkForce?.distance(60).strength(0.5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const charge: any = fg.d3Force('charge');
    charge?.strength(-180);
  }, [nodes.length, links.length]);

  // Data the canvas will read. We pass plain arrays — react-force-graph
  // will mutate them with x/y/vx/vy.
  const graphData = useMemo(() => ({ nodes, links }), [nodes, links]);

  return (
    <div ref={containerRef} className="relative h-full w-full bg-neutral-950">
      <FG
        ref={ref}
        width={size.w}
        height={size.h}
        graphData={graphData}
        backgroundColor="#0a0a0a"
        cooldownTicks={120}
        d3VelocityDecay={0.25}
        nodeRelSize={1}
        nodeId="id"
        linkSource="source"
        linkTarget="target"
        enableNodeDrag={true}
        onNodeDragStart={(node: unknown) => {
          dragSeed.current = {
            id: (node as CanvasNode).id,
            x: (node as CanvasNode).x ?? 0,
            y: (node as CanvasNode).y ?? 0,
          };
        }}
        onNodeDrag={(node: unknown) => {
          const seed = dragSeed.current;
          const n = node as CanvasNode;
          if (!seed || seed.id !== n.id) return;
          if (!n.isHub) return; // only hubs do rigid group-drag
          const dx = (n.x ?? 0) - seed.x;
          const dy = (n.y ?? 0) - seed.y;
          const members = membersByHub?.get(n.id) ?? [];
          if (members.length === 0) return;
          // Translate every member by (dx, dy) once relative to the seed
          // position, so the cluster keeps its internal shape.
          for (const mid of members) {
            const m = graphData.nodes.find((x) => x.id === mid);
            if (!m) continue;
            // Pin the member at seed.x + dx, seed.y + dy relative to their
            // original offset stored on the node itself the first time we
            // see them in this drag session.
            // We store the original offset on the node directly.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const o = m as any;
            if (o.__dragOffsetX == null) {
              o.__dragOffsetX = (o.x ?? 0) - seed.x;
              o.__dragOffsetY = (o.y ?? 0) - seed.y;
            }
            o.fx = seed.x + dx + o.__dragOffsetX;
            o.fy = seed.y + dy + o.__dragOffsetY;
          }
        }}
        onNodeDragEnd={(node: unknown) => {
          const n = node as CanvasNode;
          if (n.isHub) {
            const members = membersByHub?.get(n.id) ?? [];
            for (const mid of members) {
              const m = graphData.nodes.find((x) => x.id === mid);
              if (!m) continue;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const o = m as any;
              delete o.fx;
              delete o.fy;
              delete o.__dragOffsetX;
              delete o.__dragOffsetY;
            }
          }
          dragSeed.current = null;
        }}
        onNodeClick={(n: unknown) => {
          const cn = n as CanvasNode;
          onSelect?.(cn);
          // Center the camera on the clicked node
          ref.current?.centerAt(cn.x, cn.y, 600);
        }}
        onBackgroundClick={() => onBackgroundClick?.()}
        nodeCanvasObject={(node: unknown, ctx: CanvasRenderingContext2D, scale: number) => {
          const n = node as CanvasNode;
          const dimmed = lineageKeep ? !lineageKeep.has(n.id) : false;
          const r = nodeRadius(n);
          drawShape(ctx, n, r, dimmed);
          // Selection ring
          if (selectedId === n.id) {
            ctx.beginPath();
            ctx.strokeStyle = '#f5b301';
            ctx.lineWidth = 2;
            ctx.arc(n.x ?? 0, n.y ?? 0, r + 4, 0, Math.PI * 2);
            ctx.stroke();
          }
          // Label only when not dimmed AND scale is big enough OR is a hub
          if (!dimmed && (scale > 1.2 || n.isHub)) {
            const fontSize = n.isHub ? 13 / scale : 9 / scale;
            ctx.font = `${n.isHub ? '600' : '400'} ${fontSize}px Inter, system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = n.isHub ? '#fde68a' : '#e5e5e5';
            const label = n.label.length > 28 ? n.label.slice(0, 26) + '…' : n.label;
            ctx.fillText(label, n.x ?? 0, (n.y ?? 0) + r + 3);
          }
        }}
        linkCanvasObject={(link: unknown, ctx: CanvasRenderingContext2D) => {
          // d3-force mutates `source` / `target` from string ids into the
          // resolved node objects after the first simulation tick.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const l = link as any;
          const src = l.source && typeof l.source === 'object' ? (l.source as CanvasNode) : null;
          const tgt = l.target && typeof l.target === 'object' ? (l.target as CanvasNode) : null;
          if (!src || !tgt) return;
          const dimmedS = lineageKeep ? !lineageKeep.has(src.id) : false;
          const dimmedT = lineageKeep ? !lineageKeep.has(tgt.id) : false;
          const dim = dimmedS || dimmedT;
          ctx.beginPath();
          ctx.strokeStyle = dim ? l.color + '22' : l.color + 'cc';
          ctx.lineWidth = l.width;
          if (l.style === 'dashed') ctx.setLineDash([4, 3]);
          else if (l.style === 'dotted') ctx.setLineDash([1, 4]);
          else ctx.setLineDash([]);
          ctx.moveTo(src.x ?? 0, src.y ?? 0);
          ctx.lineTo(tgt.x ?? 0, tgt.y ?? 0);
          ctx.stroke();
          ctx.setLineDash([]);
        }}
        linkDirectionalArrowLength={(link: unknown) => {
          const l = link as unknown as CanvasLink;
          return l.isHubEdge || l.relation === 'same_session' ? 0 : 3;
        }}
        linkDirectionalArrowRelPos={1}
        linkDirectionalArrowColor={(link: unknown) =>
          (link as unknown as CanvasLink).color
        }
      />
    </div>
  );
}

/**
 * Convert MockNode/MockEdge into the canvas shape, applying the per-mode
 * colour function provided by the page.
 */
export function buildCanvasData(opts: {
  nodes: MockNode[];
  edges: MockEdge[];
  hubMembers: Map<string, string[]>;
  hubLabel: (key: string) => string;
  hubKey: (n: MockNode) => string | null;
  hubColor: string;
  pickNodeColor: (n: MockNode) => string;
  pickNodeShape: (n: MockNode) => CanvasNode['shape'];
  shortLabel: (n: MockNode) => string;
}): { nodes: CanvasNode[]; links: CanvasLink[]; membersByHub: Map<string, string[]> } {
  const canvasNodes: CanvasNode[] = [];
  const canvasLinks: CanvasLink[] = [];
  const membersByHub = new Map<string, string[]>();
  const nodeIds = new Set(opts.nodes.map((n) => n.id));

  // Hub nodes + member edges
  for (const [key, members] of opts.hubMembers) {
    if (members.length === 0) continue;
    const hubId = `hub:${key}`;
    canvasNodes.push({
      id: hubId,
      label: opts.hubLabel(key),
      color: opts.hubColor,
      size: members.length,
      isHub: true,
      shape: 'hex',
    });
    membersByHub.set(hubId, members);
    for (const mid of members) {
      canvasLinks.push({
        id: `${hubId}->${mid}`,
        source: hubId,
        target: mid,
        relation: 'origin',
        color: '#52525b',
        width: 0.6,
        style: 'dashed',
        isHubEdge: true,
      });
    }
  }

  for (const n of opts.nodes) {
    canvasNodes.push({
      id: n.id,
      label: opts.shortLabel(n),
      color: opts.pickNodeColor(n),
      size: 8,
      isHub: false,
      shape: opts.pickNodeShape(n),
      raw: n,
    });
  }

  for (const e of opts.edges) {
    if (!nodeIds.has(e.from_node) || !nodeIds.has(e.to_node)) continue;
    canvasLinks.push({
      id: e.id,
      source: e.from_node,
      target: e.to_node,
      relation: e.relation_type,
      color: edgeColor(e.relation_type),
      width: edgeWidth(e.relation_type, e.confidence),
      style: edgeStyle(e.relation_type),
      isHubEdge: false,
    });
  }

  return { nodes: canvasNodes, links: canvasLinks, membersByHub };
}

function edgeColor(rel: string): string {
  switch (rel) {
    case 'belongs_to_page': return '#a78bfa';
    case 'navigated_from':  return '#fb923c';
    case 'same_session':    return '#52525b';
    case 'mentions':        return '#22d3ee';
    case 'extends':         return '#84cc16';
    case 'cites':           return '#facc15';
    case 'contradicts':     return '#f87171';
    case 'supersedes':      return '#34d399';
    case 'user_linked':     return '#f5b301';
    default:                return '#737373';
  }
}

function edgeWidth(rel: string, confidence: number): number {
  const base = Math.max(0.4, Math.min(2.2, confidence * 2));
  if (rel === 'belongs_to_page' || rel === 'navigated_from') return base + 0.4;
  if (rel === 'same_session') return 0.4;
  return base;
}

function edgeStyle(rel: string): CanvasLink['style'] {
  if (rel === 'same_session') return 'dotted';
  if (rel === 'navigated_from' || rel === 'cites' || rel === 'contradicts') return 'dashed';
  return 'solid';
}
