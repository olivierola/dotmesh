/**
 * Force-directed graph canvas — custom HTMLCanvasElement renderer.
 *
 * Replaces react-force-graph-2d which had a brittle desktop hit-test
 * (shadow-canvas) where many nodes ended up unpickable. Now we own the
 * pipeline end-to-end:
 *
 *   - d3-force does the physics simulation (centre + many-body + link).
 *   - Rendering is a single canvas, redrawn each tick + each interaction.
 *   - Hit-test is a plain in-script geometric check (distance-to-node)
 *     run on every mousemove/mousedown. Zero shadow buffers, no pixel ID
 *     trickery — every node is always pickable.
 *   - Pan & zoom: standard wheel-to-zoom + drag-empty-area-to-pan, both
 *     mapped through a single transform applied to all coordinates.
 *   - Dragging a hub also drags all its members rigidly (translation).
 */

import { useEffect, useRef, useState } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { MockNode, MockEdge } from '@/lib/mock';

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

function hasPosition(n: CanvasNode): boolean {
  return Number.isFinite(n.x) && Number.isFinite(n.y);
}

function hashUnit(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

function prepareNodesForCanvas(
  nodes: CanvasNode[],
  membersByHub: Map<string, string[]> | undefined,
): void {
  // ForceGraph builds its invisible pointer canvas on mount. Give every
  // node a real x/y before that so desktop mouse hit-testing is reliable.
  for (const n of nodes) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = n as any;
    delete o.fx;
    delete o.fy;
  }

  const hubs = nodes.filter((n) => n.isHub);
  const ringRadius = Math.max(220, hubs.length * 80);
  hubs.forEach((hub, i) => {
    if (hasPosition(hub)) return;
    const angle = (i / Math.max(hubs.length, 1)) * Math.PI * 2;
    hub.x = Math.cos(angle) * ringRadius;
    hub.y = Math.sin(angle) * ringRadius;
  });

  const hubById = new Map(hubs.map((h) => [h.id, h]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  if (membersByHub) {
    for (const [hubId, memberIds] of membersByHub) {
      const hub = hubById.get(hubId);
      if (!hub) continue;
      memberIds.forEach((mid, j) => {
        const m = nodeById.get(mid);
        if (!m || hasPosition(m)) return;
        const a = (j / Math.max(memberIds.length, 1)) * Math.PI * 2;
        const r = 60 + hashUnit(mid) * 30;
        m.x = (hub.x ?? 0) + Math.cos(a) * r;
        m.y = (hub.y ?? 0) + Math.sin(a) * r;
      });
    }
  }

  let stray = 0;
  for (const n of nodes) {
    if (hasPosition(n)) continue;
    const a = (stray++ * 137.5 * Math.PI) / 180;
    const r = ringRadius * 1.4;
    n.x = Math.cos(a) * r;
    n.y = Math.sin(a) * r;
  }
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

/** d3-force friendly view of our CanvasNode (it mutates x/y/vx/vy). */
type SimNode = CanvasNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode> & {
  id: string;
  relation: string;
  color: string;
  width: number;
  style: 'solid' | 'dashed' | 'dotted';
  isHubEdge: boolean;
};

export default function ForceGraphCanvas({
  nodes,
  links,
  lineageKeep,
  membersByHub,
  onSelect,
  onBackgroundClick,
  selectedId,
}: ForceGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Live refs the render/hit-test loops read — using refs avoids React
  // re-renders on every tick.
  const transformRef = useRef({ x: 0, y: 0, k: 1 });
  const hoveredRef = useRef<string | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const lineageKeepRef = useRef<Set<string> | null>(lineageKeep ?? null);
  const selectedIdRef = useRef<string | null>(selectedId ?? null);

  useEffect(() => {
    lineageKeepRef.current = lineageKeep ?? null;
  }, [lineageKeep]);
  useEffect(() => {
    selectedIdRef.current = selectedId ?? null;
  }, [selectedId]);

  // Measure the container so the canvas matches it.
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

  // ---- Simulation + data wiring -----------------------------------------
  //
  // We rebuild the simulation whenever the *dataset cardinality* changes.
  // The simulation mutates the same SimNode objects we render, so positions
  // survive across re-renders that only change `selectedId` / `lineageKeep`.
  useEffect(() => {
    if (!size.w || !size.h) return;

    // Cast: d3-force adds vx/vy to nodes; that's compatible with our type.
    const simNodes = nodes as SimNode[];
    prepareNodesForCanvas(simNodes, membersByHub);

    // Resolve link endpoints into node references (d3 wants objects).
    const idToNode = new Map(simNodes.map((n) => [n.id, n]));
    const simLinks: SimLink[] = [];
    for (const l of links) {
      const s = idToNode.get(l.source);
      const t = idToNode.get(l.target);
      if (!s || !t) continue;
      simLinks.push({
        ...l,
        source: s,
        target: t,
      });
    }

    nodesRef.current = simNodes;
    linksRef.current = simLinks;

    const sim = forceSimulation<SimNode, SimLink>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance((l) => (l.isHubEdge ? 120 : 80))
          .strength(0.08),
      )
      .force('charge', forceManyBody<SimNode>().strength(-380).distanceMax(400))
      .force('center', forceCenter(0, 0).strength(0.04))
      .force(
        'collide',
        forceCollide<SimNode>().radius((n) => nodeRadius(n) + 4),
      )
      .alpha(0.6)
      .alphaDecay(0.025);

    simRef.current = sim;

    // We don't redraw on every tick (would cost ~60 fps unnecessarily for
    // bigger graphs) — instead we always redraw in our requestAnimationFrame
    // loop installed below.
    sim.on('tick', () => {
      /* no-op — RAF handles render */
    });

    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [nodes, links, membersByHub, size.w, size.h]);

  // ---- Render loop ------------------------------------------------------

  useEffect(() => {
    if (!size.w || !size.h) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let rafId = 0;
    const render = () => {
      rafId = requestAnimationFrame(render);
      const w = size.w;
      const h = size.h;
      ctx.save();
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, w, h);

      // World transform: translate(centerX + tx, centerY + ty) then scale.
      const t = transformRef.current;
      ctx.translate(w / 2 + t.x, h / 2 + t.y);
      ctx.scale(t.k, t.k);

      const lineage = lineageKeepRef.current;

      // Links
      for (const l of linksRef.current) {
        const s = l.source as SimNode;
        const tg = l.target as SimNode;
        if (!Number.isFinite(s.x) || !Number.isFinite(tg.x)) continue;
        const dim = lineage ? !lineage.has(s.id) || !lineage.has(tg.id) : false;
        const baseColor = l.color;
        ctx.strokeStyle = dim ? baseColor + '22' : baseColor + 'cc';
        ctx.lineWidth = l.width / Math.max(t.k, 0.4);
        if (l.style === 'dashed') ctx.setLineDash([6, 4]);
        else if (l.style === 'dotted') ctx.setLineDash([2, 4]);
        else ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(s.x ?? 0, s.y ?? 0);
        ctx.lineTo(tg.x ?? 0, tg.y ?? 0);
        ctx.stroke();

        // Arrow for non-hub edges
        if (!l.isHubEdge && l.relation !== 'same_session') {
          drawArrowHead(ctx, s, tg, l.color, t.k);
        }
      }
      ctx.setLineDash([]);

      // Nodes
      for (const n of nodesRef.current) {
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        const dimmed = lineage ? !lineage.has(n.id) : false;
        const r = nodeRadius(n);
        drawNode(ctx, n, r, dimmed);
        // Selection ring
        if (selectedIdRef.current === n.id) {
          ctx.beginPath();
          ctx.strokeStyle = '#f5b301';
          ctx.lineWidth = 2 / t.k;
          ctx.arc(n.x ?? 0, n.y ?? 0, r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        // Hover ring
        if (hoveredRef.current === n.id && selectedIdRef.current !== n.id) {
          ctx.beginPath();
          ctx.strokeStyle = '#fde68a';
          ctx.lineWidth = 1.5 / t.k;
          ctx.arc(n.x ?? 0, n.y ?? 0, r + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
        // Label
        if (!dimmed && (t.k > 1.2 || n.isHub)) {
          const fontSize = (n.isHub ? 12 : 8) / t.k;
          ctx.font = `${n.isHub ? '600' : '400'} ${fontSize}px Inter, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = n.isHub ? '#fde68a' : '#e5e5e5';
          const label = n.label.length > 28 ? n.label.slice(0, 26) + '…' : n.label;
          ctx.fillText(label, n.x ?? 0, (n.y ?? 0) + r + 3);
        }
      }

      ctx.restore();
    };
    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, [size.w, size.h]);

  // ---- Mouse interactions ----------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w) return;

    // Translate a client point to world coordinates (pre-transform).
    const toWorld = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect();
      const t = transformRef.current;
      const cx = clientX - r.left - size.w / 2 - t.x;
      const cy = clientY - r.top - size.h / 2 - t.y;
      return { x: cx / t.k, y: cy / t.k };
    };

    /** Find the topmost node under (wx, wy). Hubs win over leaves on ties. */
    const nodeAt = (wx: number, wy: number): SimNode | null => {
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const n of nodesRef.current) {
        if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
        const dx = (n.x ?? 0) - wx;
        const dy = (n.y ?? 0) - wy;
        const d = Math.sqrt(dx * dx + dy * dy);
        // Hit radius is a bit larger than the visible shape; bigger for hubs.
        const r = nodeRadius(n) + (n.isHub ? 6 : 8);
        if (d > r) continue;
        // Bias toward hubs when the cursor sits in overlap regions.
        const score = d - (n.isHub ? 4 : 0);
        if (score < bestD) {
          bestD = score;
          best = n;
        }
      }
      return best;
    };

    // Drag state
    let dragNode: SimNode | null = null;
    let dragOffset = { dx: 0, dy: 0 };
    let panning = false;
    let panLast = { x: 0, y: 0 };
    let mouseDownAt = 0;
    let downPoint = { x: 0, y: 0 };
    // For rigid hub-group drag
    let groupMembers: SimNode[] = [];
    let groupOffsets: Map<string, { dx: number; dy: number }> = new Map();

    const onMouseMove = (e: MouseEvent) => {
      const world = toWorld(e.clientX, e.clientY);
      if (dragNode) {
        const newX = world.x + dragOffset.dx;
        const newY = world.y + dragOffset.dy;
        dragNode.fx = newX;
        dragNode.fy = newY;
        // Move members rigidly with the hub.
        if (groupMembers.length > 0) {
          for (const m of groupMembers) {
            const off = groupOffsets.get(m.id);
            if (!off) continue;
            m.fx = newX + off.dx;
            m.fy = newY + off.dy;
          }
        }
        simRef.current?.alpha(0.3).restart();
      } else if (panning) {
        transformRef.current = {
          ...transformRef.current,
          x: transformRef.current.x + (e.clientX - panLast.x),
          y: transformRef.current.y + (e.clientY - panLast.y),
        };
        panLast = { x: e.clientX, y: e.clientY };
      } else {
        // Just hover detection
        const n = nodeAt(world.x, world.y);
        hoveredRef.current = n?.id ?? null;
        canvas.style.cursor = n ? 'pointer' : 'grab';
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // only left button for now
      const world = toWorld(e.clientX, e.clientY);
      const n = nodeAt(world.x, world.y);
      mouseDownAt = Date.now();
      downPoint = { x: e.clientX, y: e.clientY };
      if (n) {
        dragNode = n;
        dragOffset = { dx: (n.x ?? 0) - world.x, dy: (n.y ?? 0) - world.y };
        // If it's a hub, snapshot its members' relative offsets for rigid drag.
        groupMembers = [];
        groupOffsets = new Map();
        if (n.isHub && membersByHub) {
          const memberIds = membersByHub.get(n.id) ?? [];
          for (const mid of memberIds) {
            const m = nodesRef.current.find((x) => x.id === mid);
            if (!m) continue;
            groupMembers.push(m);
            groupOffsets.set(m.id, {
              dx: (m.x ?? 0) - (n.x ?? 0),
              dy: (m.y ?? 0) - (n.y ?? 0),
            });
          }
        }
        simRef.current?.alphaTarget(0.3).restart();
        canvas.style.cursor = 'grabbing';
      } else {
        panning = true;
        panLast = { x: e.clientX, y: e.clientY };
        canvas.style.cursor = 'grabbing';
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      const heldMs = Date.now() - mouseDownAt;
      const moved =
        Math.abs(e.clientX - downPoint.x) > 4 || Math.abs(e.clientY - downPoint.y) > 4;
      if (dragNode) {
        // Release fx/fy unless the node was barely moved (treat as click).
        if (!moved && heldMs < 250) {
          // Click on a node — call onSelect, release pin immediately.
          onSelect?.(dragNode);
          delete dragNode.fx;
          delete dragNode.fy;
          for (const m of groupMembers) {
            delete m.fx;
            delete m.fy;
          }
        } else {
          // Real drag: release pin so simulation reabsorbs naturally.
          delete dragNode.fx;
          delete dragNode.fy;
          for (const m of groupMembers) {
            delete m.fx;
            delete m.fy;
          }
        }
        simRef.current?.alphaTarget(0);
        dragNode = null;
        groupMembers = [];
        groupOffsets = new Map();
      } else if (panning) {
        if (!moved && heldMs < 250) {
          onBackgroundClick?.();
        }
        panning = false;
      }
      canvas.style.cursor = 'grab';
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const t = transformRef.current;
      // World coords under the pointer BEFORE zoom change
      const wx = (px - size.w / 2 - t.x) / t.k;
      const wy = (py - size.h / 2 - t.y) / t.k;
      const dir = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newK = Math.max(0.2, Math.min(5, t.k * dir));
      // Adjust translation so the point under the cursor stays fixed.
      const newTx = px - size.w / 2 - wx * newK;
      const newTy = py - size.h / 2 - wy * newK;
      transformRef.current = { x: newTx, y: newTy, k: newK };
    };

    const onContextMenu = (e: MouseEvent) => {
      // Right-click on a node: unpin (escape hatch from a sticky drag).
      e.preventDefault();
      const world = toWorld(e.clientX, e.clientY);
      const n = nodeAt(world.x, world.y);
      if (n) {
        delete n.fx;
        delete n.fy;
        simRef.current?.alpha(0.3).restart();
      }
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);

    // Touch — map single-touch to mouse-equivalent semantics.
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t0 = e.touches[0]!;
      onMouseDown({
        button: 0,
        clientX: t0.clientX,
        clientY: t0.clientY,
      } as MouseEvent);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t0 = e.touches[0]!;
      onMouseMove({
        clientX: t0.clientX,
        clientY: t0.clientY,
      } as MouseEvent);
      // Block native scroll when actually dragging something.
      if (dragNode || panning) e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      const last = e.changedTouches[0];
      if (!last) return;
      onMouseUp({
        clientX: last.clientX,
        clientY: last.clientY,
      } as MouseEvent);
    };
    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);

    return () => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
    };
  }, [size.w, size.h, membersByHub, onSelect, onBackgroundClick]);

  // ---- Render -----------------------------------------------------------

  return (
    <div ref={containerRef} className="absolute inset-0 bg-neutral-950">
      <canvas
        ref={canvasRef}
        className="block touch-none select-none"
        style={{ cursor: 'grab' }}
      />
    </div>
  );
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  s: SimNode,
  t: SimNode,
  color: string,
  scale: number,
) {
  const sx = s.x ?? 0;
  const sy = s.y ?? 0;
  const tx = t.x ?? 0;
  const ty = t.y ?? 0;
  const dx = tx - sx;
  const dy = ty - sy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;
  const ux = dx / len;
  const uy = dy / len;
  // Stop a few px short of the target node.
  const r = nodeRadius(t) + 1;
  const ex = tx - ux * r;
  const ey = ty - uy * r;
  const size = 6 / Math.max(scale, 0.5);
  const px = -uy;
  const py = ux;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - ux * size + px * size * 0.5, ey - uy * size + py * size * 0.5);
  ctx.lineTo(ex - ux * size - px * size * 0.5, ey - uy * size - py * size * 0.5);
  ctx.closePath();
  ctx.fillStyle = color + 'cc';
  ctx.fill();
}

/**
 * Convert MockNode/MockEdge into the canvas shape.
 */
/** Extra hub layer: a single central hub linked to N child sub-hubs, each
 *  of which is linked to a set of node ids. Used by the Graph page to
 *  build a "Me" hub connected to per-collection sub-hubs that gather their
 *  member memories. Sub-hubs come on top of the existing per-site hubs
 *  produced from `hubMembers`. */
export interface ExtraHubLayer {
  centerId: string;
  centerLabel: string;
  centerColor: string;
  centerSize?: number;
  subHubs: Array<{
    id: string;
    label: string;
    color: string;
    icon?: string | null;
    members: string[];
  }>;
  /** Ids of already-created hubs (e.g. site hubs from hubMembers) that
   *  should ALSO be linked to the center. The center→hub edge is added
   *  but the hub is not duplicated. */
  alsoLinkHubIds?: string[];
}

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
  extraHubs?: ExtraHubLayer | null;
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

  // ---- Extra hub layer: "Me" + per-collection sub-hubs ----
  if (opts.extraHubs) {
    const { centerId, centerLabel, centerColor, centerSize, subHubs, alsoLinkHubIds } =
      opts.extraHubs;
    canvasNodes.push({
      id: centerId,
      label: centerLabel,
      color: centerColor,
      size: centerSize ?? 60,
      isHub: true,
      shape: 'circle',
    });
    membersByHub.set(centerId, [
      ...subHubs.map((s) => s.id),
      ...(alsoLinkHubIds ?? []),
    ]);

    for (const sub of subHubs) {
      canvasNodes.push({
        id: sub.id,
        label: sub.icon ? `${sub.icon} ${sub.label}` : sub.label,
        color: sub.color,
        size: Math.max(8, sub.members.length),
        isHub: true,
        shape: 'hex',
      });
      // Center → sub-hub link
      canvasLinks.push({
        id: `${centerId}->${sub.id}`,
        source: centerId,
        target: sub.id,
        relation: 'me_to_collection',
        color: centerColor,
        width: 1.5,
        style: 'solid',
        isHubEdge: true,
      });
      // Sub-hub → each member memory
      const ownedMembers: string[] = [];
      for (const mid of sub.members) {
        if (!nodeIds.has(mid)) continue;
        ownedMembers.push(mid);
        canvasLinks.push({
          id: `${sub.id}->${mid}`,
          source: sub.id,
          target: mid,
          relation: 'collection_member',
          color: sub.color + '55',
          width: 0.5,
          style: 'dashed',
          isHubEdge: true,
        });
      }
      membersByHub.set(sub.id, ownedMembers);
    }

    // Extra center → existing-hub links (e.g. center → each site hub).
    // The destination hub already exists in canvasNodes (created earlier),
    // so we only push the edge.
    for (const hubId of alsoLinkHubIds ?? []) {
      canvasLinks.push({
        id: `${centerId}->${hubId}`,
        source: centerId,
        target: hubId,
        relation: 'me_to_hub',
        color: centerColor + 'aa',
        width: 1.0,
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
    case 'note_link':       return '#f5b301';
    default:                return '#737373';
  }
}

function edgeWidth(rel: string, confidence: number): number {
  const base = Math.max(0.4, Math.min(2.2, confidence * 2));
  if (rel === 'belongs_to_page' || rel === 'navigated_from') return base + 0.4;
  if (rel === 'same_session') return 0.4;
  if (rel === 'note_link') return Math.max(1.8, base + 0.8);
  return base;
}

function edgeStyle(rel: string): CanvasLink['style'] {
  if (rel === 'same_session') return 'dotted';
  if (rel === 'navigated_from' || rel === 'cites' || rel === 'contradicts') return 'dashed';
  if (rel === 'note_link') return 'solid';
  return 'solid';
}
