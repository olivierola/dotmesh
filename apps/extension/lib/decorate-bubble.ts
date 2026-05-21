/**
 * Post-injection bubble decoration.
 *
 * After the user submits an injected prompt, the chatbot renders a bubble
 * containing the FULL context_block + the original query. That bubble is
 * visually unreadable — a wall of instructions/memory plus the actual
 * question buried at the bottom.
 *
 * This module watches for the new user bubble to appear after submission,
 * rewrites it to show:
 *   - the original user prompt at the top,
 *   - a row of coloured badges (one per injected element: instruction /
 *     memory node) below, each typed by the element's `kind` / `node_type`.
 *
 * The LLM still receives the full text on the wire; we only swap the
 * DOM rendering of the user bubble. Cleanup runs on URL change or page
 * unload so we don't leak observers between conversations.
 */

import type { AgentAdapter } from './injector';
import { findLastUserBubble } from './injector';

export interface InjectedItem {
  kind: 'instruction' | 'node';
  id: string;
  title: string;
  node_type?: string;
  score?: number;
  /** Full body shown when the badge is clicked. Instructions: the full
   *  instruction text. Nodes: the description / summary / content excerpt. */
  full_text?: string;
  /** For memory nodes: the original URL the capture came from. */
  source_url?: string | null;
}

interface DecorationRequest {
  adapter: AgentAdapter;
  originalPrompt: string;
  items: InjectedItem[];
  /** Full injected text we sent — used to recognise the bubble that carries
   *  our payload (substring match against bubble.textContent). */
  injectedText: string;
}

const TYPE_COLORS: Record<string, string> = {
  text:   '#60a5fa',
  image:  '#f472b6',
  video:  '#fb923c',
  link:   '#22d3ee',
  code:   '#a78bfa',
  quote:  '#facc15',
  page:   '#34d399',
  action: '#e879f9',
};
const INSTRUCTION_COLOR = '#f5b301';

const DECORATED_ATTR = 'data-mesh-decorated';
const STYLE_ID = 'mesh-bubble-decoration-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    .mesh-decorated-prompt {
      font: inherit;
      color: inherit;
      white-space: pre-wrap;
      margin: 0 0 8px 0;
    }
    .mesh-decorated-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(255,255,255,0.08);
    }
    .mesh-decorated-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 11px;
      line-height: 1.4;
      font-weight: 500;
      font-family: inherit;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
      transition: filter 120ms ease, transform 120ms ease;
    }
    .mesh-decorated-badge:hover {
      filter: brightness(1.2);
      transform: translateY(-1px);
    }
    .mesh-decorated-badge::before {
      content: '';
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: currentColor;
      opacity: 0.85;
      flex: 0 0 auto;
    }

    /* ---- Popup for badge click ---- */
    #mesh-badge-popup-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(4px);
      z-index: 2147483646;
      animation: meshFadeIn 120ms ease both;
    }
    @keyframes meshFadeIn { from { opacity: 0 } to { opacity: 1 } }
    #mesh-badge-popup {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(520px, 92vw);
      max-height: 80vh;
      overflow-y: auto;
      background: #0a0a0a;
      color: #e5e5e5;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.6);
      z-index: 2147483647;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 13px;
      line-height: 1.5;
      animation: meshPopIn 140ms ease both;
    }
    @keyframes meshPopIn {
      from { opacity: 0; transform: translate(-50%, -48%) scale(0.96); }
      to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    #mesh-badge-popup .mesh-pop-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 18px 12px;
      border-bottom: 1px solid #1a1a1a;
    }
    #mesh-badge-popup .mesh-pop-title {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 14px;
    }
    #mesh-badge-popup .mesh-pop-kind {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      padding: 2px 7px;
      border-radius: 999px;
    }
    #mesh-badge-popup button.mesh-pop-close {
      background: transparent;
      border: 0;
      color: #737373;
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    #mesh-badge-popup button.mesh-pop-close:hover { color: #d4d4d4; }
    #mesh-badge-popup .mesh-pop-body {
      padding: 14px 18px 18px;
      color: #d4d4d4;
    }
    #mesh-badge-popup .mesh-pop-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 12px;
      font-size: 11px;
      color: #a3a3a3;
    }
    #mesh-badge-popup .mesh-pop-meta span {
      display: inline-flex;
      gap: 4px;
    }
    #mesh-badge-popup .mesh-pop-content {
      margin-top: 12px;
      padding: 10px 12px;
      background: #141414;
      border: 1px solid #1f1f1f;
      border-radius: 8px;
      white-space: pre-wrap;
      max-height: 280px;
      overflow-y: auto;
      color: #d4d4d4;
      font-size: 12px;
    }
  `;
  document.head.appendChild(s);
}

function colourFor(item: InjectedItem): string {
  if (item.kind === 'instruction') return INSTRUCTION_COLOR;
  if (item.node_type && TYPE_COLORS[item.node_type]) return TYPE_COLORS[item.node_type]!;
  return '#9ca3af';
}

function badgeLabel(item: InjectedItem): string {
  if (item.kind === 'instruction') return `📜 ${item.title}`;
  const icon = {
    image: '🖼',
    video: '🎬',
    link: '🔗',
    code: '⌨',
    quote: '❝',
    page: '📄',
    action: '✨',
    text: '💬',
  }[item.node_type ?? 'text'];
  return `${icon ?? '•'} ${item.title}`;
}

function closePopup(): void {
  document.getElementById('mesh-badge-popup-backdrop')?.remove();
  document.getElementById('mesh-badge-popup')?.remove();
}

function openPopup(item: InjectedItem): void {
  closePopup();
  const c = colourFor(item);

  const backdrop = document.createElement('div');
  backdrop.id = 'mesh-badge-popup-backdrop';
  backdrop.addEventListener('click', closePopup);
  document.body.appendChild(backdrop);

  const pop = document.createElement('div');
  pop.id = 'mesh-badge-popup';
  pop.addEventListener('click', (e) => e.stopPropagation());

  const head = document.createElement('div');
  head.className = 'mesh-pop-head';
  const title = document.createElement('div');
  title.className = 'mesh-pop-title';
  const kind = document.createElement('span');
  kind.className = 'mesh-pop-kind';
  kind.textContent = item.kind === 'instruction' ? 'instruction' : item.node_type ?? 'memory';
  kind.style.color = c;
  kind.style.background = c + '22';
  kind.style.border = `1px solid ${c}55`;
  const text = document.createElement('span');
  text.textContent = item.title;
  title.appendChild(kind);
  title.appendChild(text);
  head.appendChild(title);

  const close = document.createElement('button');
  close.className = 'mesh-pop-close';
  close.textContent = '✕';
  close.addEventListener('click', closePopup);
  head.appendChild(close);

  pop.appendChild(head);

  const body = document.createElement('div');
  body.className = 'mesh-pop-body';

  if (item.kind === 'instruction') {
    body.innerHTML = `
      <p style="margin:0;color:#a3a3a3;">This custom instruction was prepended to your prompt because Mesh judged it relevant to what you asked.</p>
      <div class="mesh-pop-content"></div>
      <div class="mesh-pop-meta"></div>
    `;
    const content = body.querySelector<HTMLElement>('.mesh-pop-content');
    if (content) content.textContent = item.full_text ?? '(instruction text not available)';
    const meta = body.querySelector<HTMLElement>('.mesh-pop-meta');
    if (meta && typeof item.score === 'number') {
      const s = document.createElement('span');
      s.textContent = `Relevance: ${(item.score * 100).toFixed(0)}%`;
      meta.appendChild(s);
    }
  } else {
    body.innerHTML = `
      <p style="margin:0;color:#a3a3a3;">A captured memory was used as context for this answer.</p>
      <div class="mesh-pop-content"></div>
      <div class="mesh-pop-meta"></div>
    `;
    const content = body.querySelector<HTMLElement>('.mesh-pop-content');
    if (content) content.textContent = item.full_text ?? item.title;
    const meta = body.querySelector<HTMLElement>('.mesh-pop-meta');
    if (meta) {
      if (item.node_type) {
        const s = document.createElement('span');
        s.textContent = `Type: ${item.node_type}`;
        meta.appendChild(s);
      }
      if (item.source_url) {
        const link = document.createElement('a');
        link.href = item.source_url;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        link.style.color = c;
        link.textContent = 'Open source ↗';
        meta.appendChild(link);
      }
      if (typeof item.score === 'number') {
        const s = document.createElement('span');
        s.textContent = `Relevance: ${(item.score * 100).toFixed(0)}%`;
        meta.appendChild(s);
      }
    }
  }
  pop.appendChild(body);

  document.body.appendChild(pop);

  // Esc closes too
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closePopup();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  document.addEventListener('keydown', onKey, true);
}

/**
 * Render the decorated UI inside `target`. Replaces existing text content.
 */
function paintBadges(target: HTMLElement, req: DecorationRequest): void {
  target.setAttribute(DECORATED_ATTR, '1');
  // Wipe the host page's children so they don't keep the injected wall of text.
  target.innerHTML = '';

  const prompt = document.createElement('div');
  prompt.className = 'mesh-decorated-prompt';
  prompt.textContent = req.originalPrompt;
  target.appendChild(prompt);

  if (req.items.length === 0) return;

  const row = document.createElement('div');
  row.className = 'mesh-decorated-badges';

  for (const item of req.items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `mesh-decorated-badge ${item.kind === 'instruction' ? 'mesh-decorated-instructions' : 'mesh-decorated-nodes'}`;
    const c = colourFor(item);
    b.style.color = c;
    b.style.background = c + '22';
    b.style.border = `1px solid ${c}55`;
    b.textContent = badgeLabel(item);
    b.title = 'Click to see what was injected';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPopup(item);
    });
    row.appendChild(b);
  }

  target.appendChild(row);
}

/**
 * Find the bubble that carries our injected text and decorate it.
 * Returns true on success.
 */
function tryDecorate(req: DecorationRequest): boolean {
  const bubble = findLastUserBubble(req.adapter);
  if (!bubble) return false;
  if (bubble.getAttribute(DECORATED_ATTR) === '1') return true;

  // Heuristic match: the bubble should contain a recognisable chunk of
  // what we injected. Use the original prompt as the marker because it's
  // shorter and always present in the injected text.
  const text = bubble.textContent ?? '';
  const marker = req.originalPrompt.slice(0, 30);
  if (!text.includes(marker)) {
    console.log(
      '[Mesh] decorate: bubble found but prompt marker missing',
      { marker, bubbleStart: text.slice(0, 60) },
    );
    return false;
  }

  // Find the deepest descendant that holds the actual text. If the adapter
  // provided a finer text selector, prefer it; otherwise we paint over the
  // bubble itself.
  let target: HTMLElement = bubble;
  if (req.adapter.userBubbleTextSelector) {
    const inner = bubble.querySelector<HTMLElement>(
      req.adapter.userBubbleTextSelector.split(',')[0]?.trim() ?? '',
    );
    if (inner) target = inner;
  }
  console.log('[Mesh] decorate: painting badges on', target);
  paintBadges(target, req);
  return true;
}

/**
 * Watch the page until the bubble carrying our injected text appears, then
 * decorate it. Times out after `timeoutMs`. Returns a cleanup function.
 */
export function scheduleBubbleDecoration(
  req: DecorationRequest,
  timeoutMs = 12_000,
): () => void {
  ensureStyle();
  console.log(
    '[Mesh] decorate: scheduling for',
    req.adapter.label ?? req.adapter.hostname,
    'with',
    req.items.length,
    'item(s)',
  );

  // Best-effort immediate attempt — sometimes the bubble is already there
  // (synchronous chatbots, instant echo).
  if (tryDecorate(req)) {
    return () => {};
  }

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    observer.disconnect();
    clearTimeout(timer);
  };

  const observer = new MutationObserver(() => {
    if (tryDecorate(req)) finish();
  });
  observer.observe(document.body, { subtree: true, childList: true });

  const timer = setTimeout(() => {
    // Last attempt before giving up.
    const ok = tryDecorate(req);
    if (!ok) {
      console.warn(
        '[Mesh] decorate: timed out — no bubble matched the injected text',
        { hostname: req.adapter.hostname, items: req.items.length },
      );
    }
    finish();
  }, timeoutMs);

  return finish;
}
