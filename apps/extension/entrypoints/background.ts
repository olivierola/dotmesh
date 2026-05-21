/**
 * Background service worker.
 * - Receives signals from content scripts
 * - Dedups via fingerprints
 * - Pushes to Mesh API
 * - Retries failed requests with exponential backoff
 * - Handles injection queries from content scripts
 */

import { defineBackground } from 'wxt/sandbox';
import { db, getSetting, setSetting } from '@/lib/db';
import { fingerprintOf } from '@/lib/fingerprint';
import { pushNode, inject } from '@/lib/api-client';
import { scoreSignal, type SignalInput } from '@/lib/scorer';
import { shouldAttemptInjection, refreshKeywordsIfStale } from '@/lib/trigger';
import { getAuth } from '@/lib/auth';
import { extractManual, type Extracted, type NodeType } from '@/lib/extract';
import { touchSession } from '@/lib/session';
import { isDomainBlocked } from '@/lib/blocked-domains';

function manualExtracted(opts: {
  text: string;
  url?: string;
  title?: string;
  nodeType?: NodeType;
}): Extracted {
  const e = extractManual(opts.text, opts.url);
  if (opts.title) e.title = opts.title;
  if (opts.nodeType) e.node_type = opts.nodeType;
  return e;
}

export default defineBackground(() => {
  console.log('[Mesh] background worker started');

  // Periodic flush of pending queue + keyword refresh for the trigger scorer
  chrome.alarms.create('mesh-flush-queue', { periodInMinutes: 1 });
  chrome.alarms.create('mesh-refresh-keywords', { periodInMinutes: 10 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'mesh-flush-queue') flushQueue().catch((e) => console.warn('[Mesh] flush failed', e));
    if (alarm.name === 'mesh-refresh-keywords') refreshKeywordsIfStale().catch(console.warn);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'CAPTURE_SIGNAL') {
      handleSignal(msg.signal as SignalInput, msg.metadata).then(sendResponse);
      return true; // async response
    }
    if (msg.type === 'INJECT_REQUEST') {
      handleInjectRequest(msg.query, msg.targetAgent).then(sendResponse);
      return true;
    }
    if (msg.type === 'FLUSH_QUEUE') {
      flushQueue()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    return false;
  });

  // ===== Context menu: right-click → Save to Mesh =====
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
      id: 'mesh-save-selection',
      title: 'Save selection to Mesh',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'mesh-save-page',
      title: 'Save this page to Mesh',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'mesh-save-link',
      title: 'Save this link to Mesh',
      contexts: ['link'],
    });
  });

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'mesh-save-selection' && info.selectionText) {
      await manualCapture({
        content: info.selectionText,
        url: tab?.url ?? '',
        sourceApp: tab?.url ? hostOf(tab.url) : 'web',
        extracted: manualExtracted({
          text: info.selectionText,
          url: tab?.url,
          title: tab?.title,
          nodeType: 'text',
        }),
      });
    } else if (info.menuItemId === 'mesh-save-page' && tab?.url) {
      const title = tab.title ?? '(untitled)';
      await manualCapture({
        content: `${title}\n${tab.url}`,
        url: tab.url,
        sourceApp: hostOf(tab.url),
        extracted: manualExtracted({
          text: title,
          url: tab.url,
          title,
          nodeType: 'page',
        }),
      });
    } else if (info.menuItemId === 'mesh-save-link' && info.linkUrl) {
      await manualCapture({
        content: info.linkUrl,
        url: info.linkUrl,
        sourceApp: 'web',
        extracted: manualExtracted({
          text: info.linkUrl,
          url: info.linkUrl,
          nodeType: 'link',
        }),
      });
    }
  });

  // ===== Global keyboard commands =====
  chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'quick-capture') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      let selection = '';
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.getSelection()?.toString() ?? '',
        });
        selection = (results[0]?.result as string | undefined) ?? '';
      } catch {
        /* may fail on chrome:// pages */
      }
      const text = selection || (tab.title ?? '(untitled)');
      await manualCapture({
        content: text,
        url: tab.url ?? '',
        sourceApp: tab.url ? hostOf(tab.url) : 'web',
        extracted: manualExtracted({
          text,
          url: tab.url,
          title: tab.title,
          nodeType: selection ? 'text' : 'page',
        }),
      });
    }
    if (command === 'ask-mesh') {
      const webUrl =
        (import.meta.env.VITE_PUBLIC_WEB_URL as string | undefined) ?? 'http://localhost:5173';
      chrome.tabs.create({ url: `${webUrl}/assistant` });
    }
  });
});

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'web';
  }
}

async function manualCapture(input: {
  content: string;
  url: string;
  sourceApp: string;
  extracted: Extracted;
}): Promise<void> {
  const auth = await getAuth();
  if (!auth) {
    notify('Sign in to Mesh first', 'Open the extension popup and sign in.');
    return;
  }
  const paused = await getSetting<boolean>('paused', false);
  if (paused) {
    notify('Capture paused', 'Resume from the extension popup.');
    return;
  }
  // Never capture the Mesh app itself — we'd loop indefinitely.
  if (input.url && (await isDomainBlocked(input.url))) {
    notify('Skipped', 'This site is on the blocklist (Mesh / sensitive domains).');
    return;
  }
  const fingerprint = await fingerprintOf('manual', input.content);
  const session = await touchSession(input.url || null);
  await db.queue.add({
    status: 'pending',
    payload: {
      content: input.content,
      source: 'extension',
      source_url: input.url || undefined,
      source_app: input.sourceApp,
      tags: ['manual'],
      score: 1,
      metadata: {
        captureType: 'manual',
        elementType: input.extracted.node_type,
        pageTitle: input.extracted.title ?? undefined,
        mediaUrl: input.extracted.media_url ?? undefined,
        capturedAt: input.extracted.source_extracted_at,
        extracted: input.extracted,
        session_id: session.session_id,
        session_is_new: session.is_new,
        previous_url: session.previous_url,
      },
    },
    attempts: 0,
    ts: Date.now(),
    fingerprint,
  });
  await db.fingerprints.put({ hash: fingerprint, ts: Date.now() });
  flushQueue().catch((e) => console.warn('[Mesh] flush failed', e));
  notify('Saved to Mesh', input.content.slice(0, 100));
}

function notify(title: string, message: string): void {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('/icon/128.png'),
      title,
      message,
    });
  } catch {
    /* notifications permission may not be granted */
  }
}

async function handleInjectRequest(
  query: string,
  targetAgent: string,
): Promise<{
  should_inject: boolean;
  context_block: string | null;
  node_ids: string[];
  instruction_ids?: string[];
  injected_items?: Array<{
    kind: 'instruction' | 'node';
    id: string;
    title: string;
    node_type?: string;
    score?: number;
  }>;
  reason?: string;
} | null> {
  // Gate 1: auth
  const auth = await getAuth();
  if (!auth) {
    console.log('[Mesh] inject skipped: not authenticated');
    return null;
  }

  // Gate 2: pause toggle
  const paused = await getSetting<boolean>('paused', false);
  if (paused) {
    console.log('[Mesh] inject skipped: paused');
    return null;
  }

  // Gate 3: local trigger scorer — cheap obvious-reject without an API call
  const trigger = await shouldAttemptInjection(query);
  console.log('[Mesh] inject trigger:', trigger.reason, 'ok=', trigger.ok);
  if (!trigger.ok) {
    return { should_inject: false, context_block: null, node_ids: [] };
  }

  const result = await inject(query, targetAgent);
  console.log(
    '[Mesh] inject result:',
    result
      ? {
          should_inject: result.should_inject,
          nodes: result.node_ids?.length ?? 0,
          instructions: (result as { instruction_ids?: string[] }).instruction_ids?.length ?? 0,
        }
      : 'null',
  );
  return result;
}

async function handleSignal(
  signal: SignalInput,
  metadata: Record<string, unknown> = {},
): Promise<{ ok: boolean; decision: string; error?: string }> {
  try {
    // Defence-in-depth: even if the content script forgot to check, never
    // ingest signals from a blocked domain (e.g. the Mesh SaaS itself).
    if (signal.url && (await isDomainBlocked(signal.url))) {
      return { ok: false, decision: 'blocked_domain' };
    }
    // Skip everything if the user is paused or signed out
    const paused = await getSetting<boolean>('paused', false);
    if (paused) return { ok: false, decision: 'paused' };
    const auth = await getAuth();
    if (!auth) return { ok: false, decision: 'unauthenticated' };

    // Explicit user actions (hover-click) bypass the scorer entirely.
    // The scorer is only for passive/auto signals that may not deserve a push.
    const isExplicit = signal.signalType === 'hover';

    const result = scoreSignal(signal);
    if (!isExplicit && result.decision !== 'push') {
      console.log('[Mesh] signal dropped by scorer', {
        type: signal.signalType,
        score: result.score,
        reason: result.reason,
      });
      return { ok: false, decision: result.decision };
    }
    if (result.decision === 'block') {
      console.warn('[Mesh] signal blocked (sensitive content)', signal.signalType);
      return { ok: false, decision: 'block' };
    }

    const fingerprint = await fingerprintOf(signal.signalType, signal.content);
    // Dedup (skip for explicit actions — user may want to re-capture)
    if (!isExplicit) {
      const existing = await db.fingerprints.get(fingerprint);
      if (existing && Date.now() - existing.ts < 7 * 86400_000) {
        return { ok: false, decision: 'duplicate' };
      }
    }

    const sourceApp = (metadata.sourceApp as string | undefined) ?? undefined;
    // Strip sourceApp from the metadata blob to avoid duplicating it
    const { sourceApp: _drop, ...metaRest } = metadata as { sourceApp?: string } & Record<
      string,
      unknown
    >;

    // Session tracking — every capture extends the sliding window and
    // remembers the previous URL so process-node can wire navigated_from.
    const session = await touchSession(signal.url ?? null);

    // Defensive deep-clone so any non-serializable refs raise here (with details
    // in the error) instead of silently breaking the Dexie write.
    let cleanMeta: Record<string, unknown>;
    try {
      cleanMeta = JSON.parse(
        JSON.stringify({
          ...metaRest,
          relevance: result.relevance,
          novelty: result.novelty,
          intent: result.intent,
          signalType: signal.signalType,
          session_id: session.session_id,
          session_is_new: session.is_new,
          previous_url: session.previous_url,
          referrer_url: (metaRest as { referrerUrl?: string }).referrerUrl ?? null,
        }),
      );
    } catch (e) {
      console.warn('[Mesh] metadata not serializable, dropping it', e);
      cleanMeta = { signalType: signal.signalType };
    }

    await db.queue.add({
      status: 'pending',
      payload: {
        content: signal.content,
        source: 'extension',
        source_url: signal.url,
        source_app: sourceApp,
        tags: [signal.signalType],
        score: isExplicit ? 1 : result.score,
        sensitivity: result.sensitivity,
        metadata: cleanMeta,
      },
      attempts: 0,
      ts: Date.now(),
      fingerprint,
    });
    await db.fingerprints.put({ hash: fingerprint, ts: Date.now() });

    console.log(
      '[Mesh] signal queued',
      signal.signalType,
      (signal.content ?? '').slice(0, 80),
    );
    // Try immediate push — DO await it for explicit hovers so the UI can
    // show the real success/failure state (green check vs red bang).
    if (isExplicit) {
      const pushResult = await flushQueue();
      if (pushResult.lastFailure) {
        return {
          ok: false,
          decision: 'push_failed',
          error: pushResult.lastFailure,
        };
      }
    } else {
      flushQueue().catch((e) => console.warn('[Mesh] flush failed', e));
    }
    return { ok: true, decision: 'queued' };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    console.error('[Mesh] handleSignal threw', e);
    return { ok: false, decision: 'error', error: msg };
  }
}

async function flushQueue(): Promise<{ pushed: number; lastFailure: string | null }> {
  const pending = await db.queue.where('status').equals('pending').limit(10).toArray();
  let lastFailure: string | null = null;
  let hadSuccess = false;
  let pushed = 0;

  for (const item of pending) {
    const result = await pushNode({ ...item.payload, fingerprint: item.fingerprint });
    if ('node_id' in result) {
      await db.queue.update(item.id!, { status: 'sent' });
      hadSuccess = true;
      pushed++;
    } else {
      const attempts = item.attempts + 1;
      lastFailure = result.error;
      console.warn('[Mesh] pushNode failed', result.error);
      if (attempts >= 5) {
        await db.queue.update(item.id!, { status: 'failed', attempts });
      } else {
        await db.queue.update(item.id!, { attempts });
      }
    }
  }

  // Clear last_error on first successful flush, set it otherwise
  if (hadSuccess && !lastFailure) {
    await setSetting('last_error', null);
  } else if (lastFailure) {
    await setSetting('last_error', lastFailure);
  }
  return { pushed, lastFailure };
}
