/**
 * Hover-to-capture: shows a floating "+" button on hover over any
 * meaningful element (text block, link, image, video, code).
 * Click captures content + surrounding context.
 */

type ElementType = 'text' | 'heading' | 'link' | 'image' | 'video' | 'code' | 'quote' | 'list-item';

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

function extractContent(target: CaptureTarget): {
  content: string;
  elementType: ElementType;
  mediaUrl?: string;
  surroundingContext?: string;
} {
  const { el, type } = target;

  if (type === 'image') {
    const img = el.tagName === 'IMG' ? (el as HTMLImageElement) : el.querySelector('img');
    const src = img?.currentSrc || img?.src || '';
    const alt = img?.alt || '';
    const figcaption = el.closest('figure')?.querySelector('figcaption')?.textContent?.trim() ?? '';
    const surroundingContext = collectSurroundingText(el, 400);
    const parts = [`[Image] ${src}`];
    if (alt) parts.push(`Alt: ${alt}`);
    if (figcaption) parts.push(`Caption: ${figcaption}`);
    if (surroundingContext) parts.push(`Context: ${surroundingContext}`);
    return { content: parts.join('\n'), elementType: type, mediaUrl: src, surroundingContext };
  }

  if (type === 'video') {
    const video = el as HTMLVideoElement;
    const src = video.currentSrc || video.src || '';
    const poster = video.poster || '';
    const surroundingContext = collectSurroundingText(el, 400);
    const parts = [`[Video] ${src || '(streaming source)'}`];
    if (poster) parts.push(`Poster: ${poster}`);
    if (surroundingContext) parts.push(`Context: ${surroundingContext}`);
    return { content: parts.join('\n'), elementType: type, mediaUrl: src, surroundingContext };
  }

  if (type === 'link') {
    const a = el as HTMLAnchorElement;
    const text = (a.textContent ?? '').trim();
    return {
      content: `[Link] ${a.href}\n${text}`,
      elementType: type,
      mediaUrl: a.href,
    };
  }

  if (type === 'code') {
    const text = (el.textContent ?? '').trim().slice(0, 4000);
    const lang =
      el.className.match(/language-([a-z0-9+#-]+)/i)?.[1] ??
      el.getAttribute('data-language') ??
      'unknown';
    return { content: `[Code:${lang}]\n${text}`, elementType: type };
  }

  // Default: text-like
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  const label =
    type === 'heading' ? 'Heading'
    : type === 'quote' ? 'Quote'
    : type === 'list-item' ? 'List item'
    : 'Excerpt';
  return { content: `[${label}] ${text}`, elementType: type };
}

function collectSurroundingText(el: HTMLElement, maxLen: number): string {
  const parent = el.parentElement;
  if (!parent) return '';
  let text = '';
  for (const child of Array.from(parent.children)) {
    if (child === el) continue;
    if (child.matches('script, style, [data-mesh-ui]')) continue;
    const t = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t.length > 20) text += t + ' ';
    if (text.length > maxLen) break;
  }
  return text.slice(0, maxLen).trim();
}

function onCaptureClick(e: MouseEvent): void {
  e.stopPropagation();
  e.preventDefault();
  if (!currentTarget || !buttonEl) return;
  const target = currentTarget;
  const extracted = extractContent(target);

  // Lock visual state to "saving"
  buttonEl.textContent = '...';
  buttonEl.style.background = '#a3a3a3';

  chrome.runtime.sendMessage(
    {
      type: 'CAPTURE_SIGNAL',
      signal: {
        content: extracted.content,
        url: window.location.href,
        signalType: 'hover',
        dwellMs: 0,
        scrollDepth: 0,
      },
      metadata: {
        sourceApp: window.location.hostname,
        captureType: 'hover',
        elementType: extracted.elementType,
        mediaUrl: extracted.mediaUrl,
        surroundingContext: extracted.surroundingContext,
        pageTitle: document.title,
        capturedAt: new Date().toISOString(),
      },
    },
    (response) => {
      if (!buttonEl) return;
      const ok = response?.ok === true || response?.decision === 'queued';
      buttonEl.textContent = ok ? '✓' : '!';
      buttonEl.style.background = ok ? '#22c55e' : '#f87171';
      buttonEl.style.color = '#ffffff';
      capturedSet.add(target.el);
      setTimeout(() => {
        if (buttonEl) buttonEl.style.display = 'none';
        currentTarget = null;
      }, 1000);
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
