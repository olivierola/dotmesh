/**
 * Passive page-visit tracker.
 *
 * Replaces the noisy "reading signal", "attention tracker" and
 * "ai_session" signals with a SINGLE capture sent once at the end of a
 * visit. While the user is on the page we accumulate light signals in
 * memory:
 *   - URL, title, hostname
 *   - arrival time / departure time (→ dwell duration)
 *   - max scroll depth
 *   - click and hover counts (sampled, not per event)
 *   - the page's main body text (best-effort, captured once when stable)
 *   - referrer
 *
 * On visibility hidden / beforeunload / SPA URL change we flush a single
 * payload to the background. process-node receives it and asks the LLM
 * to write a short narrative ("read article X on Y for Z minutes,
 * focused on …") which is what actually gets stored.
 *
 * Pages too short (<8s dwell, no scroll, no text) are dropped silently
 * so we don't spam the memory with every drive-by tab.
 */

import { safeSendMessage, runtimeIsAlive } from './runtime';
import { extractPage, extractPageBase } from './extract';

const MIN_DWELL_MS = 8_000;
const MIN_SCROLL_DEPTH = 0.15;
const MAX_BODY_CHARS = 6000;

interface VisitState {
  url: string;
  hostname: string;
  title: string;
  startedAt: number;
  maxScrollDepth: number;
  clickCount: number;
  hoverCount: number;
  referrer: string;
  /** Captured once the page is reasonably stable (debounced after load). */
  bodyText: string | null;
  flushed: boolean;
}

let state: VisitState | null = null;
let hoverSampleAt = 0;
let installed = false;

function newState(): VisitState {
  return {
    url: location.href,
    hostname: location.hostname,
    title: document.title,
    startedAt: Date.now(),
    maxScrollDepth: 0,
    clickCount: 0,
    hoverCount: 0,
    referrer: document.referrer || '',
    bodyText: null,
    flushed: false,
  };
}

function captureBodyTextOnce(): void {
  if (!state || state.bodyText) return;
  try {
    const ex = extractPage();
    state.bodyText = ex.content?.slice(0, MAX_BODY_CHARS) ?? null;
  } catch {
    /* never let the tracker crash the host page */
  }
}

/**
 * Compose the single payload that gets sent to the backend. The LLM at
 * the other end (process-node's cleanup + extracted-completion) is what
 * turns this into a narrative + summary.
 */
function buildPayload(s: VisitState): {
  content: string;
  metadata: Record<string, unknown>;
} {
  const dwellMs = Date.now() - s.startedAt;
  const base = extractPageBase();
  const summaryLines: string[] = [];
  summaryLines.push(`Visit: ${s.title || s.url}`);
  summaryLines.push(`URL: ${s.url}`);
  if (s.referrer) summaryLines.push(`From: ${s.referrer}`);
  summaryLines.push(`Dwell: ${Math.round(dwellMs / 1000)}s`);
  summaryLines.push(`Max scroll depth: ${Math.round(s.maxScrollDepth * 100)}%`);
  summaryLines.push(`Clicks: ${s.clickCount} · Hovers: ${s.hoverCount}`);
  if (s.bodyText) {
    summaryLines.push('');
    summaryLines.push('Body excerpt:');
    summaryLines.push(s.bodyText);
  }
  const content = summaryLines.join('\n');
  const metadata = {
    sourceApp: s.hostname,
    captureType: 'visit',
    elementType: 'page',
    pageTitle: s.title,
    capturedAt: new Date().toISOString(),
    referrerUrl: s.referrer || null,
    visit: {
      dwell_ms: dwellMs,
      max_scroll_depth: s.maxScrollDepth,
      clicks: s.clickCount,
      hovers: s.hoverCount,
    },
    extracted: {
      ...base,
      node_type: 'page',
      content: s.bodyText,
      media_url: null,
      media_thumbnail: null,
      actions: [
        { kind: 'page-view', value: 'visit', at: new Date(s.startedAt).toISOString() },
        { kind: 'dwell', value: `${Math.round(dwellMs / 1000)}s`, at: new Date().toISOString() },
      ],
    },
  };
  return { content, metadata };
}

function shouldDrop(s: VisitState): string | null {
  const dwell = Date.now() - s.startedAt;
  if (dwell < MIN_DWELL_MS) return `too_short:${Math.round(dwell / 1000)}s`;
  if (s.maxScrollDepth < MIN_SCROLL_DEPTH && (!s.bodyText || s.bodyText.length < 400)) {
    return 'no_engagement';
  }
  return null;
}

async function flush(reason: 'leave' | 'hidden' | 'url-change'): Promise<void> {
  if (!state || state.flushed) return;
  if (!runtimeIsAlive()) return;
  // Capture the body now if we never did (e.g. fast leave).
  if (!state.bodyText) captureBodyTextOnce();
  const dropReason = shouldDrop(state);
  if (dropReason) {
    console.log('[Mesh] visit dropped', dropReason, state.url);
    state.flushed = true;
    return;
  }
  state.flushed = true;
  const { content, metadata } = buildPayload(state);
  const dwellMs = Date.now() - state.startedAt;
  safeSendMessage({
    type: 'CAPTURE_SIGNAL',
    signal: {
      content,
      url: state.url,
      signalType: 'reading', // re-use existing signal type so the backend
                              // pipeline doesn't need a migration.
      dwellMs,
      scrollDepth: state.maxScrollDepth,
    },
    metadata: {
      ...metadata,
      flushReason: reason,
    },
  });
}

function startNewVisit(): void {
  // Flush the previous one if any (SPA navigation).
  if (state && !state.flushed) {
    flush('url-change');
  }
  state = newState();
  // Capture body once the page is stable.
  setTimeout(captureBodyTextOnce, 2000);
}

export function installVisitTracker(): void {
  if (installed) return;
  installed = true;
  state = newState();

  // Capture the body once after page settles.
  setTimeout(captureBodyTextOnce, 2000);

  window.addEventListener('scroll', () => {
    if (!state) return;
    const h = document.documentElement;
    const depth = (h.scrollTop + window.innerHeight) / Math.max(h.scrollHeight, 1);
    if (depth > state.maxScrollDepth) state.maxScrollDepth = Math.min(depth, 1);
  }, { passive: true, capture: true });

  document.addEventListener('click', () => {
    if (state) state.clickCount++;
  }, { passive: true, capture: true });

  // Sample hovers — only one per second to keep the counter cheap.
  document.addEventListener('mousemove', () => {
    if (!state) return;
    const now = Date.now();
    if (now - hoverSampleAt < 1000) return;
    hoverSampleAt = now;
    state.hoverCount++;
  }, { passive: true, capture: true });

  // SPA URL change — most apps push to history without firing unload.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      startNewVisit();
    }
  }, 1500);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush('hidden');
  });
  window.addEventListener('pagehide', () => flush('leave'));
  window.addEventListener('beforeunload', () => flush('leave'));
}
