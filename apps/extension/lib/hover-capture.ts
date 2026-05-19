/**
 * Hover-to-capture: shows a floating "+" button on hover over any
 * meaningful element (text block, link, image, video, code).
 * Click captures content + surrounding context.
 */

import { extractFromElement, contentFromExtracted, type NodeType } from './extract';

type ElementType = 'text' | 'heading' | 'link' | 'image' | 'video' | 'code' | 'quote' | 'list-item';

function toNodeType(t: ElementType): NodeType {
  if (t === 'heading' || t === 'list-item') return 'text';
  return t;
}

interface CaptureTarget {
  el: HTMLElement;
  type: ElementType;
}

const CAPTURABLE_SELECTOR = [
  'p',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote',
  'pre',
  'code:not(pre code)',
  'li',
  'img',
  'video',
  'figure',
  'article',
  '[role="article"]',
  // Common social/feed item containers — best-effort
  '[data-testid="tweet"]',
  '[data-test-id="post-content"]',
  '.feed-shared-update-v2',
].join(',');

const MIN_TEXT_LEN = 20;
const BUTTON_SIZE = 28;
const BUTTON_OFFSET = 6;

let buttonEl: HTMLDivElement | null = null;
let currentTarget: CaptureTarget | null = null;
let capturedSet: WeakSet<HTMLElement> = new WeakSet();
let hideTimer: number | undefined;

function classify(el: HTMLElement): ElementType | null {
  const tag = el.tagName.toLowerCase();
  if (tag === 'img' || el.closest('figure')) return 'image';
  if (tag === 'video') return 'video';
  if (tag === 'a') return 'link';
  if (tag === 'pre' || tag === 'code') return 'code';
  if (tag === 'blockquote') return 'quote';
  if (tag === 'li') return 'list-item';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'p' || tag === 'article' || el.getAttribute('role') === 'article') return 'text';
  // social containers
  if (el.matches('[data-testid="tweet"], [data-test-id="post-content"], .feed-shared-update-v2')) {
    return 'text';
  }
  return null;
}

function isEligible(el: HTMLElement, type: ElementType): boolean {
  // Skip our own UI
  if (el.closest('[data-mesh-ui]')) return false;
  // Already captured
  if (capturedSet.has(el)) return false;
  // Skip invisible
  const rect = el.getBoundingClientRect();
  if (rect.width < 30 || rect.height < 15) return false;

  if (type === 'image') {
    const img = el as HTMLImageElement;
    return !!(img.src || img.currentSrc) && img.naturalWidth > 80;
  }
  if (type === 'video') return true;
  const text = (el.textContent ?? '').trim();
  return text.length >= MIN_TEXT_LEN;
}

function ensureButton(): HTMLDivElement {
  if (buttonEl) return buttonEl;
  const btn = document.createElement('div');
  btn.setAttribute('data-mesh-ui', 'hover-button');
  btn.style.cssText = `
    position: fixed;
    z-index: 2147483646;
    width: ${BUTTON_SIZE}px;
    height: ${BUTTON_SIZE}px;
    border-radius: 8px;
    background: #f5b301;
    color: #0a0a0a;
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 16px;
    font-weight: 700;
    line-height: 1;
    display: none;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.1);
    transition: transform 0.12s ease, background 0.18s ease;
    user-select: none;
    pointer-events: auto;
  `;
  btn.textContent = '+';
  btn.title = 'Save to Mesh';

  btn.addEventListener('mouseenter', () => {
    btn.style.transform = 'scale(1.1)';
    clearTimeout(hideTimer);
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.transform = 'scale(1)';
    scheduleHide();
  });
  btn.addEventListener('click', onCaptureClick);

  document.body.appendChild(btn);
  buttonEl = btn;
  return btn;
}

function positionButton(el: HTMLElement): void {
  const btn = ensureButton();
  const rect = el.getBoundingClientRect();
  // Top-right corner of the element, just outside
  let top = rect.top + BUTTON_OFFSET;
  let left = rect.right - BUTTON_SIZE - BUTTON_OFFSET;
  // Keep inside viewport
  top = Math.max(BUTTON_OFFSET, Math.min(window.innerHeight - BUTTON_SIZE - BUTTON_OFFSET, top));
  left = Math.max(BUTTON_OFFSET, Math.min(window.innerWidth - BUTTON_SIZE - BUTTON_OFFSET, left));
  btn.style.top = `${top}px`;
  btn.style.left = `${left}px`;
  btn.style.display = 'flex';
}

function scheduleHide(): void {
  clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (buttonEl) buttonEl.style.display = 'none';
    currentTarget = null;
  }, 250);
}

function showFor(target: CaptureTarget): void {
  clearTimeout(hideTimer);
  currentTarget = target;
  const btn = ensureButton();
  btn.textContent = '+';
  btn.style.background = '#f5b301';
  btn.style.color = '#0a0a0a';
  positionButton(target.el);
}

function findCapturable(el: HTMLElement | null): CaptureTarget | null {
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.body) {
    const type = classify(cur);
    if (type && isEligible(cur, type)) return { el: cur, type };
    cur = cur.parentElement;
  }
  return null;
}

function onCaptureClick(e: MouseEvent): void {
  e.stopPropagation();
  e.preventDefault();
  if (!currentTarget || !buttonEl) return;
  const target = currentTarget;
  const nodeType = toNodeType(target.type);
  const extracted = extractFromElement(target.el, nodeType);
  const content = contentFromExtracted(extracted);

  // Lock visual state to "saving"
  buttonEl.textContent = '...';
  buttonEl.style.background = '#a3a3a3';

  chrome.runtime.sendMessage(
    {
      type: 'CAPTURE_SIGNAL',
      signal: {
        content,
        url: window.location.href,
        signalType: 'hover',
        dwellMs: 0,
        scrollDepth: 0,
      },
      metadata: {
        sourceApp: window.location.hostname,
        captureType: 'hover',
        // Legacy fields (kept so older clients/code still see something).
        elementType: target.type,
        mediaUrl: extracted.media_url ?? undefined,
        pageTitle: document.title,
        capturedAt: new Date().toISOString(),
        // Where the user came from before landing on this page — used by
        // process-node to wire `navigated_from` parent edges.
        referrerUrl: document.referrer || null,
        // Canonical shape — process-node will fill any null fields with LLM.
        extracted,
      },
    },
    (response) => {
      if (!buttonEl) return;
      const ok = response?.ok === true || response?.decision === 'queued';
      buttonEl.textContent = ok ? '✓' : '!';
      buttonEl.style.background = ok ? '#22c55e' : '#f87171';
      buttonEl.style.color = '#ffffff';
      if (!ok) {
        const reason = response?.error || response?.decision || 'unknown';
        buttonEl.title = `Save failed: ${reason}`;
        console.warn('[Mesh] hover capture failed', response);
      } else {
        buttonEl.title = 'Saved to Mesh';
      }
      capturedSet.add(target.el);
      const linger = ok ? 1000 : 3000;
      setTimeout(() => {
        if (buttonEl) buttonEl.style.display = 'none';
        currentTarget = null;
      }, linger);
    },
  );
}

export function installHoverCapture(): void {
  // Throttle pointer moves
  let lastMoveAt = 0;
  document.addEventListener(
    'pointermove',
    (e) => {
      const now = Date.now();
      if (now - lastMoveAt < 60) return;
      lastMoveAt = now;
      const target = findCapturable(e.target as HTMLElement | null);
      if (target) {
        if (target.el !== currentTarget?.el) {
          showFor(target);
        } else {
          clearTimeout(hideTimer);
        }
      } else if (buttonEl?.style.display === 'flex') {
        // Hovering over non-capturable area — schedule hide unless cursor is on the button
        if (e.target !== buttonEl) scheduleHide();
      }
    },
    { passive: true, capture: true },
  );

  document.addEventListener('scroll', () => {
    if (currentTarget) positionButton(currentTarget.el);
  }, { passive: true, capture: true });

  window.addEventListener('blur', () => {
    if (buttonEl) buttonEl.style.display = 'none';
    currentTarget = null;
  });
}
