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
    .mesh-decorated-instructions { /* row 1 = instructions */ }
    .mesh-decorated-nodes        { /* row 2 = memory */ }
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
    const b = document.createElement('span');
    b.className = `mesh-decorated-badge ${item.kind === 'instruction' ? 'mesh-decorated-instructions' : 'mesh-decorated-nodes'}`;
    const c = colourFor(item);
    b.style.color = c;
    b.style.background = c + '22';
    b.style.border = `1px solid ${c}55`;
    b.textContent = badgeLabel(item);
    b.title =
      item.kind === 'instruction'
        ? `Custom instruction: ${item.title}`
        : `Memory: ${item.title}${item.score ? ` (score ${item.score.toFixed(2)})` : ''}`;
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
  if (!text.includes(req.originalPrompt.slice(0, 30))) return false;

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
    tryDecorate(req);
    finish();
  }, timeoutMs);

  return finish;
}
