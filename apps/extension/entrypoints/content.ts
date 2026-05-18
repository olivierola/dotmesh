/**
 * Content script — runs on every page.
 * Two responsibilities:
 *   1. Passive capture signals (reading + AI session) → background.
 *   2. On AI agent pages, intercept submission, fetch context from Mesh,
 *      show overlay, replace draft on accept.
 */

import { defineContentScript } from 'wxt/sandbox';
import { findAdapter, findInput, readDraft, writeDraft, type AgentAdapter } from '@/lib/injector';
import { mountOverlay } from '@/lib/overlay';
import { isDomainBlocked } from '@/lib/blocked-domains';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    // Early bail-out on sensitive domains. We never inject NOR capture.
    if (await isDomainBlocked(window.location.href)) {
      return;
    }

    const hostname = window.location.hostname;
    const adapter = findAdapter(hostname);

    if (adapter) {
      installAgentInjector(adapter);
      installAgentSessionSignal(hostname);
    } else {
      installReadingSignal();
      installSearchSignal(hostname);
      installActiveWorkSignal(hostname);
    }
  },
});

// --------------- Reading signal ----------------
function installReadingSignal(): void {
  let maxScroll = 0;
  const start = Date.now();
  let fired = false;

  const onScroll = () => {
    const h = document.documentElement;
    const scroll = (h.scrollTop + window.innerHeight) / h.scrollHeight;
    if (scroll > maxScroll) maxScroll = scroll;
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  const check = () => {
    if (fired) return;
    const dwell = Date.now() - start;
    if (dwell > 45_000 && maxScroll > 0.7) {
      fired = true;
      const article = document.querySelector('article, main, [role="main"]') ?? document.body;
      const text = (article.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
      if (text.length < 200) return;
      chrome.runtime.sendMessage({
        type: 'CAPTURE_SIGNAL',
        signal: {
          content: `[Reading] ${document.title}\n\n${text}`,
          url: window.location.href,
          signalType: 'reading',
          dwellMs: dwell,
          scrollDepth: maxScroll,
        },
        metadata: { sourceApp: 'web' },
      });
    }
  };
  setInterval(check, 10_000);
}

// --------------- AI session signal ----------------
function installAgentSessionSignal(hostname: string): void {
  let lastUrl = window.location.href;
  let lastCaptureAt = 0;

  const tryCapture = () => {
    const now = Date.now();
    if (now - lastCaptureAt < 30_000) return;
    const messages = document.querySelectorAll(
      '[data-message-author-role], [data-testid="conversation-turn"], main article',
    );
    if (messages.length < 2) return;
    const last = Array.from(messages).slice(-2);
    const text = last
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
      .join('\n---\n')
      .slice(0, 4000);
    if (text.length < 100) return;
    lastCaptureAt = now;
    chrome.runtime.sendMessage({
      type: 'CAPTURE_SIGNAL',
      signal: {
        content: `[AI session @ ${hostname}]\n\n${text}`,
        url: window.location.href,
        signalType: 'ai_session',
        dwellMs: 60_000,
        scrollDepth: 1,
      },
      metadata: { sourceApp: hostname },
    });
  };

  setInterval(() => {
    if (window.location.href !== lastUrl) {
      tryCapture();
      lastUrl = window.location.href;
    }
  }, 5_000);

  window.addEventListener('beforeunload', tryCapture);
}

// --------------- Injection (killer feature) ----------------
const AUTO_ACCEPT_MS = 2000;
const TRIVIAL_PATTERNS = [
  /^what time/i,
  /^translate/i,
  /^spell/i,
  /^summarize this:?$/i,
  /^hello\b/i,
  /^hi\b/i,
];

function installAgentInjector(adapter: AgentAdapter): void {
  let pendingQuery = '';
  let isShowingOverlay = false;
  let lastInjectedForQuery = '';

  // Intercept Enter (without shift) — capture phase to run before host page's handler.
  const onKeyDown = async (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (isShowingOverlay) return;

    const input = findInput(adapter);
    if (!input) return;
    const draft = readDraft(adapter, input).trim();
    if (!draft || draft === lastInjectedForQuery || draft === pendingQuery) return;
    if (draft.length < 8) return;
    if (TRIVIAL_PATTERNS.some((re) => re.test(draft))) return;

    // Block submission, then ask background for context.
    e.preventDefault();
    e.stopImmediatePropagation();
    pendingQuery = draft;
    isShowingOverlay = true;

    let context: { should_inject: boolean; context_block: string | null; node_ids: string[] } | null = null;
    try {
      context = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'INJECT_REQUEST', query: draft, targetAgent: adapter.hostname },
          (response) => resolve(response ?? null),
        );
      });
    } catch (err) {
      console.warn('[Mesh] inject request failed', err);
    }

    if (!context?.should_inject || !context.context_block) {
      // No relevant context — just let the original submission happen as if nothing intervened.
      isShowingOverlay = false;
      pendingQuery = '';
      reSubmit(adapter, input);
      return;
    }

    const previews = context.context_block
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .slice(0, 3)
      .map((l) => l.replace(/^- /, '').slice(0, 80));

    const newDraft = `${context.context_block}`;

    mountOverlay(
      {
        nodeCount: context.node_ids.length,
        previews,
        agentHostname: adapter.hostname,
        autoAcceptMs: AUTO_ACCEPT_MS,
      },
      {
        onAccept: () => {
          writeDraft(adapter, input, newDraft);
          lastInjectedForQuery = newDraft;
          isShowingOverlay = false;
          pendingQuery = '';
          // Submit on user's behalf
          reSubmit(adapter, input);
        },
        onSkip: () => {
          isShowingOverlay = false;
          pendingQuery = '';
          reSubmit(adapter, input);
        },
        onEdit: () => {
          // Replace draft but don't auto-submit, let user tweak.
          writeDraft(adapter, input, newDraft);
          lastInjectedForQuery = newDraft;
          isShowingOverlay = false;
          pendingQuery = '';
          input.focus();
        },
      },
    );
  };

  document.addEventListener('keydown', onKeyDown, true);
}

function reSubmit(_adapter: AgentAdapter, input: HTMLElement): void {
  // Send a synthetic Enter to re-trigger the agent's own submit logic.
  // We use a non-canceled bubble-phase event so our capture handler is bypassed
  // (it checks isShowingOverlay/pendingQuery).
  input.focus();
  const ev = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(ev);
}

// --------------- Search signal ----------------
function installSearchSignal(hostname: string): void {
  const isSearchEngine =
    hostname.includes('google.') ||
    hostname.includes('bing.com') ||
    hostname.includes('duckduckgo.com') ||
    hostname.includes('kagi.com');
  if (!isSearchEngine) return;

  const params = new URLSearchParams(window.location.search);
  const query = params.get('q') ?? params.get('query');
  if (!query || query.length < 4) return;

  // Wait for the user to dwell + leave (proxy: 30s + visibilitychange)
  const start = Date.now();
  let fired = false;
  const onLeave = () => {
    if (fired) return;
    const dwell = Date.now() - start;
    if (dwell < 30_000) return;
    fired = true;
    chrome.runtime.sendMessage({
      type: 'CAPTURE_SIGNAL',
      signal: {
        content: `[Search] "${query}" on ${hostname}\n${document.title}`,
        url: window.location.href,
        signalType: 'search',
        dwellMs: dwell,
        scrollDepth: 0,
      },
      metadata: { sourceApp: hostname },
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeave();
  });
  window.addEventListener('beforeunload', onLeave);
}

// --------------- Active work signal ----------------
function installActiveWorkSignal(hostname: string): void {
  const isWorkApp =
    hostname.includes('notion.so') ||
    hostname.includes('docs.google.com') ||
    hostname.includes('linear.app') ||
    hostname.includes('github.com') ||
    hostname.includes('figma.com');
  if (!isWorkApp) return;

  let lastFiredAt = 0;
  let editsSinceFlush = 0;
  let debounce: number | undefined;

  const flush = () => {
    if (editsSinceFlush < 3) return;
    if (Date.now() - lastFiredAt < 60_000) return;
    lastFiredAt = Date.now();
    editsSinceFlush = 0;

    const title = document.title;
    const focused = document.activeElement;
    const focusedText = focused && 'value' in focused
      ? String((focused as HTMLInputElement).value ?? '').slice(0, 600)
      : (focused?.textContent ?? '').slice(0, 600);

    if (!focusedText || focusedText.length < 40) return;
    chrome.runtime.sendMessage({
      type: 'CAPTURE_SIGNAL',
      signal: {
        content: `[Active work — ${hostname}]\n${title}\n\n${focusedText}`,
        url: window.location.href,
        signalType: 'active_work',
        dwellMs: 60_000,
        scrollDepth: 0.5,
      },
      metadata: { sourceApp: hostname },
    });
  };

  document.addEventListener('input', () => {
    editsSinceFlush++;
    if (debounce) clearTimeout(debounce);
    debounce = window.setTimeout(flush, 60_000);
  });
  window.addEventListener('beforeunload', flush);
}
