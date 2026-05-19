/**
 * Attention tracker: captures content that the user pays attention to
 * (visible on screen + minimal scrolling + significant dwell).
 *
 * Algorithm:
 * 1. IntersectionObserver watches significant text blocks (articles, posts, threads).
 * 2. When a block stays >60% visible for >12s without scrolling away, it scores.
 * 3. Score = base + dwell_bonus + still_bonus (no scroll = signal of focused reading).
 * 4. If score > threshold and content >120 chars: capture as 'attention' signal.
 */

const MIN_TEXT_LEN = 120;
const VISIBLE_THRESHOLD = 0.6;
const DWELL_MS = 12_000;
const STILL_WINDOW_MS = 4_000;

// Candidate selectors: feed items, articles, threads
const CANDIDATE_SELECTOR = [
  'article',
  '[role="article"]',
  '[data-testid="tweet"]',
  '[data-testid="cellInnerDiv"]',
  '.feed-shared-update-v2',
  '[data-test-id="post-content"]',
  '.Post', // Reddit-like
  '[data-ks-item]',
  'main p',
  '.thread-item',
].join(',');

interface Tracked {
  el: HTMLElement;
  visibleSince: number | null;
  lastScrollAt: number;
  captured: boolean;
}

const tracked = new Map<HTMLElement, Tracked>();
let lastScrollAt = Date.now();

function isSignificant(el: HTMLElement): boolean {
  if (el.closest('[data-mesh-ui]')) return false;
  const text = (el.textContent ?? '').trim();
  if (text.length < MIN_TEXT_LEN) return false;
  // Avoid nesting: skip if a tracked ancestor exists
  let p = el.parentElement;
  while (p) {
    if (tracked.has(p)) return false;
    p = p.parentElement;
  }
  return true;
}

function captureAttention(el: HTMLElement, dwellMs: number): void {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  const heading = el.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim() ?? '';
  const author =
    el.querySelector('[data-testid="User-Name"], .author, [rel="author"]')?.textContent?.trim() ??
    '';

  chrome.runtime.sendMessage({
    type: 'CAPTURE_SIGNAL',
    signal: {
      content: `[Attention] ${heading || document.title}\n${author ? `By: ${author}\n` : ''}\n${text}`,
      url: window.location.href,
      signalType: 'attention',
      dwellMs,
      scrollDepth: 0.5,
    },
    metadata: {
      sourceApp: window.location.hostname,
      captureType: 'attention',
      elementType: 'text',
      pageTitle: document.title,
      heading: heading || undefined,
      author: author || undefined,
      capturedAt: new Date().toISOString(),
    },
  });
}

function tick(): void {
  const now = Date.now();
  for (const [el, t] of tracked) {
    if (t.captured) continue;
    if (t.visibleSince === null) continue;
    const dwell = now - t.visibleSince;
    const stillness = now - lastScrollAt;
    if (dwell >= DWELL_MS && stillness >= STILL_WINDOW_MS) {
      t.captured = true;
      captureAttention(el, dwell);
    }
  }
}

export function installAttentionTracker(): void {
  if (typeof IntersectionObserver === 'undefined') return;

  const io = new IntersectionObserver(
    (entries) => {
      const now = Date.now();
      for (const e of entries) {
        const el = e.target as HTMLElement;
        let t = tracked.get(el);
        if (!t) {
          t = { el, visibleSince: null, lastScrollAt: now, captured: false };
          tracked.set(el, t);
        }
        if (e.intersectionRatio >= VISIBLE_THRESHOLD) {
          if (t.visibleSince === null) t.visibleSince = now;
        } else {
          t.visibleSince = null;
        }
      }
    },
    { threshold: [0, VISIBLE_THRESHOLD, 1] },
  );

  function scan(): void {
    const nodes = document.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR);
    let count = 0;
    nodes.forEach((el) => {
      if (tracked.has(el)) return;
      if (!isSignificant(el)) return;
      io.observe(el);
      tracked.set(el, { el, visibleSince: null, lastScrollAt: Date.now(), captured: false });
      count++;
      if (count > 50) return; // cap to avoid runaway
    });
  }

  // Initial + periodic scan (new feed items load over time)
  scan();
  setInterval(scan, 4_000);
  setInterval(tick, 1_500);

  window.addEventListener(
    'scroll',
    () => {
      lastScrollAt = Date.now();
    },
    { passive: true, capture: true },
  );
}
