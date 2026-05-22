/**
 * Selection-to-capture: surface a tiny "Save to Mesh" pill above the user's
 * current text selection. Click → save the selection through the regular
 * CAPTURE pipeline, just like the hover "+" button.
 *
 * Lifecycle:
 *   - selectionchange fires → if selection length >= MIN_LEN, show the pill,
 *   - mousedown anywhere → hide,
 *   - selection collapses → hide.
 *
 * The pill is rendered inside its own shadow root so the host page's CSS
 * can't interfere with it.
 */

import { safeSendMessage, runtimeIsAlive } from './runtime';
import { extractManual } from './extract';

const HOST_ID = 'mesh-selection-bubble-host';
const MIN_LEN = 5;
const MAX_LEN = 8000;

let installed = false;
let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;
let pill: HTMLButtonElement | null = null;
let label: HTMLSpanElement | null = null;

function ensureHost(): void {
  if (host) return;
  host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-mesh-ui', 'selection-bubble');
  Object.assign(host.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: '2147483645',
    pointerEvents: 'none',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  });
  document.body.appendChild(host);
  shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .bubble {
        position: fixed;
        display: none;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        background: #0a0a0a;
        color: #f5b301;
        border: 1px solid #2a2a2a;
        border-radius: 999px;
        box-shadow: 0 6px 20px rgba(0,0,0,0.45);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        pointer-events: auto;
        user-select: none;
        transition: transform 120ms ease, filter 120ms ease;
        animation: meshSlideIn 140ms ease both;
      }
      .bubble:hover { transform: translateY(-1px); filter: brightness(1.15); }
      .bubble.saved {
        color: #34d399;
        border-color: #14532d;
        background: #14532d22;
      }
      .bubble.error {
        color: #f87171;
        border-color: #7f1d1d;
      }
      @keyframes meshSlideIn {
        from { opacity: 0; transform: translateY(4px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    </style>
    <button class="bubble" data-pill type="button">
      <span data-icon>📌</span>
      <span data-label>Save to Mesh</span>
    </button>
  `;
  pill = shadow.querySelector('[data-pill]') as HTMLButtonElement;
  label = shadow.querySelector('[data-label]') as HTMLSpanElement;
}

function hide(): void {
  if (pill) pill.style.display = 'none';
}

function showAt(rect: DOMRect): void {
  if (!pill) return;
  pill.classList.remove('saved', 'error');
  if (label) label.textContent = 'Save to Mesh';
  // Position the pill above the selection, kept inside the viewport.
  const margin = 8;
  let top = rect.top - 38;
  if (top < margin) top = rect.bottom + margin;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - 70, margin),
    window.innerWidth - 150 - margin,
  );
  pill.style.top = `${top}px`;
  pill.style.left = `${left}px`;
  pill.style.display = 'inline-flex';
}

function isInOurUI(node: Node | null): boolean {
  let cur: Node | null = node;
  while (cur) {
    if (
      cur instanceof HTMLElement &&
      (cur.closest('[data-mesh-ui]') || cur.getRootNode() === shadow)
    ) {
      return true;
    }
    cur = cur.parentNode;
  }
  return false;
}

function updateForSelection(): void {
  if (!runtimeIsAlive()) {
    hide();
    return;
  }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return hide();
  const text = sel.toString().trim();
  if (text.length < MIN_LEN || text.length > MAX_LEN) return hide();
  const range = sel.getRangeAt(0);
  // Skip selections inside Mesh's own UI or inside an input/textarea
  // (we have other ways to capture those).
  if (isInOurUI(range.commonAncestorContainer)) return hide();
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return hide();
  ensureHost();
  showAt(rect);
}

async function saveCurrentSelection(): Promise<void> {
  const sel = window.getSelection();
  const text = (sel?.toString() ?? '').trim();
  if (text.length < MIN_LEN || !pill || !label) return;
  if (!runtimeIsAlive()) {
    pill.classList.add('error');
    label.textContent = 'Mesh unavailable';
    return;
  }
  label.textContent = 'Saving…';
  const extracted = extractManual(text, window.location.href);
  const response = await safeSendMessage<{ ok?: boolean; decision?: string; error?: string }>({
    type: 'CAPTURE_SIGNAL',
    signal: {
      content: text,
      url: window.location.href,
      signalType: 'hover', // explicit user action
      dwellMs: 0,
      scrollDepth: 0,
    },
    metadata: {
      sourceApp: window.location.hostname,
      captureType: 'selection',
      elementType: 'text',
      pageTitle: document.title,
      capturedAt: new Date().toISOString(),
      referrerUrl: document.referrer || null,
      extracted,
    },
  });
  if (!pill || !label) return;
  if (response?.ok || response?.decision === 'queued') {
    pill.classList.add('saved');
    label.textContent = 'Saved ✓';
    setTimeout(hide, 1100);
  } else {
    pill.classList.add('error');
    label.textContent = response?.decision === 'duplicate' ? 'Already saved' : 'Failed';
    setTimeout(hide, 1500);
  }
}

export function installSelectionCapture(): void {
  if (installed) return;
  installed = true;

  // Debounce: the user often drags a selection — fire after the mouse settles.
  let debounceTimer: number | undefined;
  document.addEventListener('selectionchange', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(updateForSelection, 80);
  });
  // Clicking outside the bubble clears the selection → naturally hides
  // via the next selectionchange tick. But also hide on mousedown so the
  // pill never lingers when the user starts a new gesture.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (isInOurUI(e.target as Node)) return;
      hide();
    },
    true,
  );

  // Wire the save action — ensureHost is called lazily on first selection.
  document.addEventListener(
    'click',
    (e) => {
      if (!pill) return;
      const path = e.composedPath();
      if (!path.includes(pill)) return;
      e.preventDefault();
      e.stopPropagation();
      saveCurrentSelection();
    },
    true,
  );
}
