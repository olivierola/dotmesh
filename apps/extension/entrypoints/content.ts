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
import { runtimeIsAlive, safeSendMessage, installRuntimeSelfDestruct } from '@/lib/runtime';
import { isDomainBlocked } from '@/lib/blocked-domains';
import { installQuickNote } from '@/lib/quick-note';
import { installSelectionCapture } from '@/lib/selection-capture';
import { installVisitTracker } from '@/lib/visit-tracker';
import { installChatbotSaveButtons } from '@/lib/chatbot-save';

/** Cleanup callbacks every install* function pushes; called on self-destruct. */
const teardowns: Array<() => void> = [];

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

    // When the extension is reloaded mid-session, every Mesh listener
    // becomes a liability — they keep trying to talk to a dead background
    // and trigger 'Extension context invalidated' / 'ERR_FAILED' floods
    // in the host page console. The self-destructor polls runtimeIsAlive
    // and tears everything down as soon as the connection drops.
    installRuntimeSelfDestruct(() => {
      for (const fn of teardowns.splice(0)) {
        try { fn(); } catch { /* ignore */ }
      }
    });

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

    const onChatbotInstalled = (chatAdapter: AgentAdapter) => {
      // On chatbot pages we also install the "Save Q&A" button under
      // every assistant message, so the user can store the question
      // they just asked together with the answer in one click.
      try {
        installChatbotSaveButtons(chatAdapter);
      } catch (err) {
        console.warn('[Mesh] chatbot save buttons failed', err);
      }
    };

    if (adapter) {
      try {
        installAgentInjector(adapter);
        onChatbotInstalled(adapter);
        console.log('[Mesh] injector installed for', adapter.label);
      } catch (err) {
        console.error('[Mesh] injector install failed', err);
      }
    } else {
      // No explicit chatbot adapter for this host. We still try to detect
      // an embedded chatbot widget (Intercom, Crisp, etc.) but everything
      // else gets the unified visit tracker.
      let installedFromAuto = false;
      const tryAutoInstall = () => {
        if (installedFromAuto) return;
        const guess = detectGenericChatbot();
        if (!guess) return;
        installedFromAuto = true;
        adapter = guess;
        try {
          installAgentInjector(guess);
          onChatbotInstalled(guess);
          console.log('[Mesh] generic chatbot detected; injector installed', guess);
        } catch (err) {
          console.warn('[Mesh] auto-adapter install failed', err);
          installedFromAuto = false;
        }
      };
      tryAutoInstall();
      const obs = new MutationObserver(() => {
        tryAutoInstall();
        if (installedFromAuto) obs.disconnect();
      });
      obs.observe(document.body, { subtree: true, childList: true });
      setTimeout(() => obs.disconnect(), 60_000);
    }

    // Always-on UX, regardless of whether this page hosts a chatbot:
    //   - visit tracker: one capture at the end of the visit,
    //   - selection bubble: pill above any selected text,
    //   - quick-note FAB: bottom-right floating button.
    // The old hover "+" on every paragraph/image/link is GONE — it was
    // too noisy and the user explicitly asked to keep only deliberate
    // capture surfaces.
    try { installVisitTracker(); } catch (err) { console.warn('[Mesh] visit tracker failed', err); }
    try { installQuickNote(); } catch (err) { console.warn('[Mesh] quick-note install failed', err); }
    try { installSelectionCapture(); } catch (err) { console.warn('[Mesh] selection capture install failed', err); }
  },
});

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

