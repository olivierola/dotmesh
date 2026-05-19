/**
 * Force-directed graph canvas backed by react-force-graph-2d.
 *
 * Wraps the bare ForceGraph2D and adds:
 *   - automatic container sizing,
 *   - rigid hub group-drag (members move with the dragged hub),
 *   - lineage dimming (nodes & links not in keep set drawn faded),
 *   - selection ring, type-aware node rendering.
 *
 * Kept deliberately small so the simulation defaults of d3-force kick in
 * and we don't trip over edge cases (e.g. all nodes stuck at the centre).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { MockNode, MockEdge } from '@/lib/mock';

// react-force-graph's TS typings disagree with our richer node shape;
// using `any` at the boundary keeps the runtime intact without leaking.
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
  /** Node ids to keep visible. null = show all. */
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

function drawNode(
  ctx: CanvasRenderingContext2D,
  n: CanvasNode,
  r: number,
  dimmed: boolean,
): void {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  ctx.beginPath();
  ctx.fillStyle = dimmed ? n.color + '33' : n.color;
  ctx.strokeStyle = dimmed ? '#0a0a0a55' : '#0a0a0a';
  ctx.lineWidth = n.isHub ? 2 : 1.5;
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
  const fgRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const dragSeed = useRef<{ id: string; x: number; y: number } | null>(null);

  // Measure the container so the canvas matches it. We start at 0,0 so
  // the canvas stays unmounted until we know its real size — prevents the
  // simulation from initialising at the wrong aspect ratio.
  useEffect(() => {
    const update = () => {
      const r = containerRef.current?.getBoundingClientRect();
      if (r && (r.width !== size.w || r.height !== size.h)) {
        setSize({ w: r.width, h: r.height });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pass the exact arrays react-force-graph mutates. We deliberately do
  // NOT recreate this object on every render (which would reset positions),
  // and we accept the small staleness because the parent already memoises
  // nodes/links per render.
  //
  // We also seed initial x/y for hubs and their members so the very first
  // paint already looks organised (hubs on a ring, members clustered
  // around their hub). d3-force only seeds at the centre by default,
  // which produces an explosion that takes many ticks to settle.
  useEffect(() => {
    const hubs = nodes.filter((n) => n.isHub);
    if (hubs.length === 0) return;
    const ringRadius = Math.max(220, hubs.length * 80);
    hubs.forEach((hub, i) => {
      // Only seed if the simulation hasn't already placed this node.
      if (typeof hub.x === 'number' && typeof hub.y === 'number') return;
      const angle = (i / hubs.length) * Math.PI * 2;
      hub.x = Math.cos(angle) * ringRadius;
      hub.y = Math.sin(angle) * ringRadius;
    });
    // Cluster leaf nodes around their hub.
    const hubById = new Map(hubs.map((h) => [h.id, h]));
    if (membersByHub) {
      for (const [hubId, memberIds] of membersByHub) {
        const hub = hubById.get(hubId);
        if (!hub) continue;
        memberIds.forEach((mid, j) => {
          const m = nodes.find((n) => n.id === mid);
          if (!m || typeof m.x === 'number') return;
          const a = (j / memberIds.length) * Math.PI * 2;
          const r = 60 + Math.random() * 30;
          m.x = (hub.x ?? 0) + Math.cos(a) * r;
          m.y = (hub.y ?? 0) + Math.sin(a) * r;
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, membersByHub]);

  const graphData = useMemo(() => ({ nodes, links }), [nodes, links]);

  // Tune forces once the instance is ready.
  // - Soft link force (low strength) so the user can stretch / pull edges
  //   freely; they pop back gently rather than snapping back rigidly.
  // - Strong charge so nodes naturally repel each other → less hairball.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const link: any = fg.d3Force('link');
    link?.distance(90).strength(0.08);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const charge: any = fg.d3Force('charge');
    charge?.strength(-380).distanceMax(400);
    fg.d3ReheatSimulation?.();
  }, [size.w, size.h]);

  const ready = size.w > 0 && size.h > 0;

  return (
    <div ref={containerRef} className="absolute inset-0 bg-neutral-950">
      {ready && (
        <FG
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={graphData}
          backgroundColor="#0a0a0a"
          cooldownTicks={300}
          warmupTicks={50}
          d3VelocityDecay={0.3}
          nodeRelSize={1}
          enableNodeDrag={true}
          enablePanInteraction={true}
          enableZoomInteraction={true}
          onNodeDragStart={(node: unknown) => {
            const n = node as CanvasNode;
            dragSeed.current = { id: n.id, x: n.x ?? 0, y: n.y ?? 0 };
            // Reheat the (probably cooled-down) simulation so neighbours
            // actually drift toward the dragged node instead of staying
            // frozen in place.
            fgRef.current?.d3ReheatSimulation?.();
          }}
          onNodeDrag={(node: unknown) => {
            const seed = dragSeed.current;
            const n = node as CanvasNode;
            if (!seed || seed.id !== n.id) return;
            if (!n.isHub) return;
            const dx = (n.x ?? 0) - seed.x;
            const dy = (n.y ?? 0) - seed.y;
            const members = membersByHub?.get(n.id) ?? [];
            for (const mid of members) {
              const m = nodes.find((x) => x.id === mid);
              if (!m) continue;
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
              // For hubs only: pin the hub and every member at their dropped
              // position so the cluster the user just shaped stays where
              // they put it. Right-click on any node unpins it.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const o = n as any;
              o.fx = n.x;
              o.fy = n.y;
              const members = membersByHub?.get(n.id) ?? [];
              for (const mid of members) {
                const m = nodes.find((x) => x.id === mid);
                if (!m) continue;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const om = m as any;
                om.fx = m.x;
                om.fy = m.y;
                delete om.__dragOffsetX;
                delete om.__dragOffsetY;
              }
            }
            // For leaf nodes we DON'T pin — d3-force keeps them mobile and
            // the link force naturally reflects the new distance the user
            // pulled. If they want a leaf to stay put, right-click pins.
            dragSeed.current = null;
          }}
          onNodeClick={(node: unknown) => {
            const n = node as CanvasNode;
            onSelect?.(n);
            fgRef.current?.centerAt?.(n.x, n.y, 600);
          }}
          onNodeRightClick={(node: unknown) => {
            // Right-click toggles pin: if pinned (fx set) release it,
            // otherwise pin at current position so the user can lock a node.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const o = node as any;
            if (typeof o.fx === 'number') {
              delete o.fx;
              delete o.fy;
            } else {
              o.fx = o.x;
              o.fy = o.y;
            }
            fgRef.current?.d3ReheatSimulation?.();
          }}
          onBackgroundClick={() => onBackgroundClick?.()}
          nodeCanvasObject={(node: unknown, ctx: CanvasRenderingContext2D, scale: number) => {
            const n = node as CanvasNode;
            const dimmed = lineageKeep ? !lineageKeep.has(n.id) : false;
            const r = nodeRadius(n);
            drawNode(ctx, n, r, dimmed);
            if (selectedId === n.id) {
              ctx.beginPath();
              ctx.strokeStyle = '#f5b301';
              ctx.lineWidth = 2;
              ctx.arc(n.x ?? 0, n.y ?? 0, r + 4, 0, Math.PI * 2);
              ctx.stroke();
            }
            if (!dimmed && (scale > 1.2 || n.isHub)) {
              const fontSize = n.isHub ? 12 / scale : 8 / scale;
              ctx.font = `${n.isHub ? '600' : '400'} ${fontSize}px Inter, system-ui, sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              ctx.fillStyle = n.isHub ? '#fde68a' : '#e5e5e5';
              const label = n.label.length > 28 ? n.label.slice(0, 26) + '…' : n.label;
              ctx.fillText(label, n.x ?? 0, (n.y ?? 0) + r + 3);
            }
          }}
          // CRITICAL: when nodeCanvasObject is used, react-force-graph delegates
          // hit-testing to nodePointerAreaPaint. If we don't paint a pickable
          // shape here, every click falls through to the pan/zoom handler —
          // which is exactly what produces the "whole graph moves as a block"
          // bug. Paint a disc slightly larger than the visible shape so small
          // nodes stay clickable too.
          nodePointerAreaPaint={(
            node: unknown,
            color: string,
            ctx: CanvasRenderingContext2D,
          ) => {
            const n = node as CanvasNode;
            const r = nodeRadius(n) + 4;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, Math.PI * 2);
            ctx.fill();
          }}
          // We use the default link rendering for crisp lines + arrows but
          // colour them per relation type via linkColor / linkWidth so the
          // basic line drawing remains performant even with thousands of
          // edges. (linkCanvasObject would force a full repaint per link.)
          linkColor={(link: unknown) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const l = link as any;
            const srcId = typeof l.source === 'object' && l.source
              ? (l.source as CanvasNode).id
              : (l.source as string);
            const tgtId = typeof l.target === 'object' && l.target
              ? (l.target as CanvasNode).id
              : (l.target as string);
            const dim = lineageKeep
              ? !lineageKeep.has(srcId) || !lineageKeep.has(tgtId)
              : false;
            return dim ? (l.color as string) + '22' : (l.color as string) + 'cc';
          }}
          linkWidth={(link: unknown) => (link as CanvasLink).width}
          linkDirectionalArrowLength={(link: unknown) => {
            const l = link as CanvasLink;
            return l.isHubEdge || l.relation === 'same_session' ? 0 : 3;
          }}
          linkDirectionalArrowRelPos={1}
          linkDirectionalArrowColor={(link: unknown) =>
            (link as CanvasLink).color
          }
        />
      )}
    </div>
  );
}

/**
 * Convert MockNode/MockEdge into the canvas shape.
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
