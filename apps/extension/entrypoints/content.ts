/**
 * Content script — runs on every page.
 * Two responsibilities:
 *   1. Passive capture signals (reading + AI session) → background.
 *   2. On AI agent pages, intercept submission, fetch context from Mesh,
 *      show overlay, replace draft on accept.
 */

import { defineContentScript } from 'wxt/sandbox';
import {
  findAdapter,
  findInput,
  findSubmit,
  readDraft,
  writeDraft,
  type AgentAdapter,
} from '@/lib/injector';
import { scheduleBubbleDecoration } from '@/lib/decorate-bubble';
import { detectGenericChatbot } from '@/lib/auto-adapter';
import { runtimeIsAlive, safeSendMessage } from '@/lib/runtime';
import { isDomainBlocked } from '@/lib/blocked-domains';
import { installHoverCapture } from '@/lib/hover-capture';
import { installAttentionTracker } from '@/lib/attention-tracker';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    console.log('[Mesh] content script loaded on', window.location.hostname);

    if (!runtimeIsAlive()) {
      console.warn(
        '[Mesh] extension context already invalidated at load time — ' +
          'refresh the page to re-attach Mesh.',
      );
      return;
    }

    // Early bail-out on sensitive domains. We never inject NOR capture.
    try {
      if (await isDomainBlocked(window.location.href)) {
        console.log('[Mesh] domain blocked, bailing');
        return;
      }
    } catch (err) {
      // Don't let a blocklist failure (e.g. IndexedDB unavailable in some
      // contexts) take the entire content script down with it. The hard-
      // coded blocklist still applied synchronously inside isDomainBlocked;
      // the failing branch is only the user-defined extras.
      console.warn('[Mesh] domain block check failed (continuing)', err);
    }

    const hostname = window.location.hostname;
    let adapter = findAdapter(hostname);
    console.log('[Mesh] adapter for', hostname, '=', adapter?.label ?? '(none)');

    if (adapter) {
      try {
        installAgentInjector(adapter);
        console.log('[Mesh] injector installed for', adapter.label);
      } catch (err) {
        console.error('[Mesh] injector install failed', err);
      }
      try {
        installAgentSessionSignal(hostname);
      } catch (err) {
        console.warn('[Mesh] session signal install failed', err);
      }
    } else {
      // No explicit adapter for this site. Run passive capture, and ALSO
      // watch the DOM for an unknown chatbot UI (widget on any site:
      // Intercom, Crisp, custom React, embedded LLM agents…). When one
      // appears we install the injector on the fly.
      try { installReadingSignal(); } catch (err) { console.warn('[Mesh] reading signal failed', err); }
      try { installSearchSignal(hostname); } catch (err) { console.warn('[Mesh] search signal failed', err); }
      try { installActiveWorkSignal(hostname); } catch (err) { console.warn('[Mesh] active work signal failed', err); }

      let installedFromAuto = false;
      const tryAutoInstall = () => {
        if (installedFromAuto) return;
        const guess = detectGenericChatbot();
        if (!guess) return;
        installedFromAuto = true;
        adapter = guess;
        try {
          installAgentInjector(guess);
          console.log('[Mesh] generic chatbot detected; injector installed', guess);
        } catch (err) {
          console.warn('[Mesh] auto-adapter install failed', err);
          installedFromAuto = false;
        }
      };
      tryAutoInstall();
      // Most widgets mount async — watch the DOM for a window so we catch
      // them as soon as they appear, then stop observing.
      const obs = new MutationObserver(() => {
        tryAutoInstall();
        if (installedFromAuto) obs.disconnect();
      });
      obs.observe(document.body, { subtree: true, childList: true });
      // Hard cap so we don't observe forever on static pages.
      setTimeout(() => obs.disconnect(), 60_000);
    }

    try { installHoverCapture(); } catch (err) { console.warn('[Mesh] hover capture install failed', err); }
    try { installAttentionTracker(); } catch (err) { console.warn('[Mesh] attention tracker install failed', err); }
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

  const fire = (reason: 'dwell' | 'leave') => {
    if (fired) return;
    const dwell = Date.now() - start;
    const article = document.querySelector('article, main, [role="main"]') ?? document.body;
    const text = (article.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (text.length < 200) return;
    fired = true;
    safeSendMessage({
      type: 'CAPTURE_SIGNAL',
      signal: {
        content: `[Reading] ${document.title}\n\n${text}`,
        url: window.location.href,
        signalType: 'reading',
        dwellMs: dwell,
        scrollDepth: maxScroll,
      },
      metadata: {
        sourceApp: window.location.hostname,
        captureType: 'reading',
        elementType: 'text',
        pageTitle: document.title,
        capturedAt: new Date().toISOString(),
        reason,
      },
    });
  };

  const check = () => {
    if (fired) return;
    const dwell = Date.now() - start;
    // Either: dwell + some scroll  OR  long dwell without scroll (deep focus)
    if ((dwell > 20_000 && maxScroll > 0.4) || dwell > 60_000) {
      fire('dwell');
    }
  };
  setInterval(check, 5_000);
  window.addEventListener('beforeunload', () => fire('leave'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') fire('leave');
  });
}

// --------------- AI session signal ----------------
function installAgentSessionSignal(hostname: string): void {
  let lastUrl = window.location.href;
  let lastCaptureAt = 0;
  let lastMessageCount = 0;

  const tryCapture = (reason: 'url-change' | 'new-messages' | 'leave') => {
    const now = Date.now();
    if (now - lastCaptureAt < 20_000) return;
    const messages = document.querySelectorAll(
      '[data-message-author-role], [data-testid="conversation-turn"], main article',
    );
    if (messages.length < 2) return;
    // Capture last 2 messages (typically last user prompt + assistant reply)
    const last = Array.from(messages).slice(-2);
    const text = last
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
      .join('\n---\n')
      .slice(0, 4000);
    if (text.length < 100) return;
    lastCaptureAt = now;
    lastMessageCount = messages.length;
    safeSendMessage({
      type: 'CAPTURE_SIGNAL',
      signal: {
        content: `[AI session @ ${hostname}]\n\n${text}`,
        url: window.location.href,
        signalType: 'ai_session',
        dwellMs: 60_000,
        scrollDepth: 1,
      },
      metadata: {
        sourceApp: hostname,
        captureType: 'ai_session',
        elementType: 'text',
        pageTitle: document.title,
        capturedAt: new Date().toISOString(),
        reason,
        messageCount: messages.length,
      },
    });
  };

  // Periodic check: URL change OR new messages arrived
  setInterval(() => {
    if (window.location.href !== lastUrl) {
      tryCapture('url-change');
      lastUrl = window.location.href;
      lastMessageCount = 0;
      return;
    }
    const messages = document.querySelectorAll(
      '[data-message-author-role], [data-testid="conversation-turn"], main article',
    );
    // If at least 2 new messages since last capture (typically a user→assistant exchange)
    if (messages.length >= lastMessageCount + 2) {
      tryCapture('new-messages');
    }
  }, 10_000);

  window.addEventListener('beforeunload', () => tryCapture('leave'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') tryCapture('leave');
  });
}

// --------------- Injection (killer feature) ----------------
const TRIVIAL_PATTERNS = [
  /^what time/i,
  /^translate/i,
  /^spell/i,
  /^summarize this:?$/i,
  /^hello\b/i,
  /^hi\b/i,
];

interface InjectedItem {
  kind: 'instruction' | 'node';
  id: string;
  title: string;
  node_type?: string;
  score?: number;
  full_text?: string;
  source_url?: string | null;
}

interface InjectResponse {
  should_inject: boolean;
  context_block: string | null;
  node_ids: string[];
  instruction_ids?: string[];
  injected_items?: InjectedItem[];
}

function installAgentInjector(adapter: AgentAdapter): void {
  let pendingQuery = '';
  let isShowingOverlay = false;
  let lastInjectedForQuery = '';
  // Guard for the brief moment between writing the injected draft and the
  // host page handling our synthetic submit — we don't want to re-fire the
  // injection on the same submit attempt.
  let suspendInjection = false;

  /**
   * Synchronous decision: should we intercept this submission attempt?
   * Reads the current draft and runs the cheap gating rules. If this
   * returns false the caller must let the original event proceed —
   * preventDefault must NOT have been called yet.
   */
  const shouldIntercept = (input: HTMLElement): { ok: true; draft: string } | { ok: false } => {
    if (suspendInjection || isShowingOverlay) return { ok: false };
    const draft = readDraft(adapter, input).trim();
    if (!draft) return { ok: false };
    if (draft === lastInjectedForQuery || draft === pendingQuery) return { ok: false };
    if (draft.length < 8) return { ok: false };
    if (TRIVIAL_PATTERNS.some((re) => re.test(draft))) return { ok: false };
    return { ok: true, draft };
  };

  /**
   * Heart of the interception: ask the background for context+instructions,
   * show the overlay, and on accept replace the draft and resubmit. Caller
   * is expected to have already preventDefault'd the originating event.
   */
  const runInjectionFlow = async (input: HTMLElement, draft: string): Promise<void> => {
    console.log(
      '[Mesh] intercepting submission on',
      adapter.hostname,
      'draft length=',
      draft.length,
    );
    pendingQuery = draft;
    isShowingOverlay = true;

    // Watchdog: if anything below stalls (no background response, no overlay
    // ack…) clear the gating flags after 10s so the next Enter isn't
    // permanently blocked.
    const watchdog = setTimeout(() => {
      if (isShowingOverlay) {
        console.warn('[Mesh] injection flow watchdog tripped — clearing state');
        isShowingOverlay = false;
        pendingQuery = '';
      }
    }, 10_000);

    // safeSendMessage swallows every messaging failure (dead background,
    // invalidated context, runtime.lastError) and resolves to null. The
    // null branch below treats that as "no context to inject" so the
    // original prompt still gets through.
    const context = await safeSendMessage<InjectResponse>({
      type: 'INJECT_REQUEST',
      query: draft,
      targetAgent: adapter.hostname,
    });
    clearTimeout(watchdog);
    if (!context) {
      console.warn(
        '[Mesh] inject request returned no context (background dead or runtime invalidated)',
      );
    }

    console.log('[Mesh] context received:', {
      should_inject: context?.should_inject,
      has_block: !!context?.context_block,
      block_preview: context?.context_block?.slice(0, 120),
    });

    if (!context?.should_inject || !context.context_block) {
      // Nothing relevant to inject — submit the original prompt unchanged.
      isShowingOverlay = false;
      pendingQuery = '';
      reSubmit(adapter, input);
      return;
    }

    // ---- Auto-inject: no overlay, no confirmation ----
    // The user discovers what was injected via the coloured badges that
    // appear on their message bubble after submission.
    const newDraft = context.context_block;
    console.log(
      '[Mesh] auto-injecting context block, length=',
      newDraft.length,
      'items=',
      context.injected_items?.length ?? 0,
    );
    writeDraft(adapter, input, newDraft);
    lastInjectedForQuery = newDraft;
    isShowingOverlay = false;
    pendingQuery = '';
    if ((context.injected_items?.length ?? 0) > 0) {
      scheduleBubbleDecoration({
        adapter,
        originalPrompt: draft,
        items: context.injected_items!,
        injectedText: newDraft,
      });
    }
    // Give React (ProseMirror / Lexical) one tick to see the new draft and
    // re-enable the submit button before we trigger it. Without this,
    // findSubmit() finds the button still disabled from the empty-state and
    // reSubmit falls back to a synthetic Enter that the editor often eats.
    await new Promise((r) => setTimeout(r, 60));
    reSubmit(adapter, input);
  };

  // ---- Intercept Enter (without shift) on the input itself ----
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (!runtimeIsAlive()) {
      // Stale content script — never intercept, let the host page handle it.
      return;
    }
    console.log('[Mesh] Enter pressed; checking interception…');
    if (isShowingOverlay || suspendInjection) {
      console.log('[Mesh] skipped: overlay=' + isShowingOverlay + ' suspend=' + suspendInjection);
      return;
    }
    const input = findInput(adapter);
    if (!input) {
      console.log('[Mesh] no input element matched the adapter selectors');
      return;
    }
    if (!input.contains(e.target as Node) && e.target !== input) {
      console.log('[Mesh] keydown target outside the adapter input — letting it through', e.target);
      return;
    }
    const decision = shouldIntercept(input);
    if (!decision.ok) {
      console.log('[Mesh] shouldIntercept declined; letting host handle the Enter');
      return;
    }
    console.log('[Mesh] intercepting Enter, draft length=' + decision.draft.length);
    e.preventDefault();
    e.stopImmediatePropagation();
    runInjectionFlow(input, decision.draft).catch((err) => {
      console.warn('[Mesh] injection flow failed', err);
      isShowingOverlay = false;
      pendingQuery = '';
    });
  };

  // ---- Intercept clicks on the submit button ----
  const onClick = (e: MouseEvent) => {
    if (!runtimeIsAlive()) return;
    if (isShowingOverlay || suspendInjection) return;
    const submit = findSubmit(adapter);
    if (!submit) return;
    const target = e.target as Node | null;
    if (!target || !(submit === target || submit.contains(target))) return;
    console.log('[Mesh] submit button click intercepted; checking…');
    const input = findInput(adapter);
    if (!input) {
      console.log('[Mesh] click: no input element');
      return;
    }
    const decision = shouldIntercept(input);
    if (!decision.ok) {
      console.log('[Mesh] click: shouldIntercept declined');
      return;
    }
    console.log('[Mesh] intercepting click, draft length=' + decision.draft.length);
    e.preventDefault();
    e.stopImmediatePropagation();
    runInjectionFlow(input, decision.draft).catch((err) => {
      console.warn('[Mesh] injection flow failed', err);
      isShowingOverlay = false;
      pendingQuery = '';
    });
  };

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('click', onClick, true);

  // DIAG: catch-all listener that fires on every keydown so we can tell
  // whether Enter is even reaching our content script context. If this
  // never fires either, the event lives in an iframe/shadow root we
  // don't have access to from this listener.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') {
        console.log('[Mesh] (diag) window keydown Enter, target=', e.target);
      }
    },
    true,
  );

  /**
   * Submit the draft as if the user had done it. We try, in order:
   *   1. click the submit button if the adapter declares one,
   *   2. fall back to a synthetic Enter on the input.
   * Either way we set suspendInjection for a short window so the host's
   * own submit handler doesn't loop back into us.
   */
  function reSubmit(_adapter: AgentAdapter, input: HTMLElement): void {
    suspendInjection = true;
    setTimeout(() => {
      suspendInjection = false;
    }, 1200);

    const submit = findSubmit(_adapter);
    if (submit && !(submit as HTMLButtonElement).disabled) {
      // Click via dispatchEvent so React's onClick handler fires.
      submit.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      return;
    }
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
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
    safeSendMessage({
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
    safeSendMessage({
      type: 'CAPTURE_SIGNAL',
      signal: {
        content: `[Active work - ${hostname}]\n${title}\n\n${focusedText}`,
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
