/**
 * Background service worker.
 * - Receives signals from content scripts
 * - Dedups via fingerprints
 * - Pushes to Mesh API
 * - Retries failed requests with exponential backoff
 * - Handles injection queries from content scripts
 */

import { defineBackground } from 'wxt/sandbox';
import { db, getSetting } from '@/lib/db';
import { fingerprintOf } from '@/lib/fingerprint';
import { pushNode, inject } from '@/lib/api-client';
import { scoreSignal, type SignalInput } from '@/lib/scorer';
import { shouldAttemptInjection, refreshKeywordsIfStale } from '@/lib/trigger';
import { getAuth } from '@/lib/auth';

export default defineBackground(() => {
  console.log('[Mesh] background worker started');

  // Periodic flush of pending queue + keyword refresh for the trigger scorer
  chrome.alarms.create('mesh-flush-queue', { periodInMinutes: 1 });
  chrome.alarms.create('mesh-refresh-keywords', { periodInMinutes: 10 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'mesh-flush-queue') flushQueue().catch(console.warn);
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
        content: `[Selection from ${tab?.title ?? 'web'}]\n\n${info.selectionText}`,
        url: tab?.url ?? '',
        sourceApp: tab?.url ? hostOf(tab.url) : 'web',
      });
    } else if (info.menuItemId === 'mesh-save-page' && tab?.url) {
      await manualCapture({
        content: `[Page] ${tab.title ?? '(untitled)'}\nURL: ${tab.url}`,
        url: tab.url,
        sourceApp: hostOf(tab.url),
      });
    } else if (info.menuItemId === 'mesh-save-link' && info.linkUrl) {
      await manualCapture({
        content: `[Link saved] ${info.linkUrl}`,
        url: info.linkUrl,
        sourceApp: 'web',
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
      const content = selection
        ? `[Quick capture] ${selection}\nFrom: ${tab.title} (${tab.url})`
        : `[Quick capture page] ${tab.title ?? '(untitled)'}\nURL: ${tab.url}`;
      await manualCapture({
        content,
        url: tab.url ?? '',
        sourceApp: tab.url ? hostOf(tab.url) : 'web',
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
  const fingerprint = await fingerprintOf('manual', input.content);
  await db.queue.add({
    status: 'pending',
    payload: {
      content: input.content,
      source: 'extension',
      source_url: input.url || undefined,
      source_app: input.sourceApp,
      tags: ['manual'],
      score: 1,
    },
    attempts: 0,
    ts: Date.now(),
    fingerprint,
  });
  await db.fingerprints.put({ hash: fingerprint, ts: Date.now() });
  flushQueue().catch(console.warn);
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
): Promise<{ should_inject: boolean; context_block: string | null; node_ids: string[] } | null> {
  // Gate 1: auth
  const auth = await getAuth();
  if (!auth) return null;

  // Gate 2: pause toggle
  const paused = await getSetting<boolean>('paused', false);
  if (paused) return null;

  // Gate 3: local trigger scorer — skip cheap obvious rejects without an API call
  const trigger = await shouldAttemptInjection(query);
  if (!trigger.ok) {
    return { should_inject: false, context_block: null, node_ids: [] };
  }

  return inject(query, targetAgent);
}

async function handleSignal(
  signal: SignalInput,
  metadata: { sourceApp?: string } = {},
): Promise<{ ok: boolean; decision: string }> {
  // Skip everything if the user is paused or signed out
  const paused = await getSetting<boolean>('paused', false);
  if (paused) return { ok: false, decision: 'paused' };
  const auth = await getAuth();
  if (!auth) return { ok: false, decision: 'unauthenticated' };

  const result = scoreSignal(signal);
  if (result.decision !== 'push') return { ok: false, decision: result.decision };

  const fingerprint = await fingerprintOf(signal.signalType, signal.content);
  // Dedup
  const existing = await db.fingerprints.get(fingerprint);
  if (existing && Date.now() - existing.ts < 7 * 86400_000) {
    return { ok: false, decision: 'duplicate' };
  }

  await db.queue.add({
    status: 'pending',
    payload: {
      content: signal.content,
      source: 'extension',
      source_url: signal.url,
      source_app: metadata.sourceApp,
      tags: [signal.signalType],
      score: result.score,
      sensitivity: result.sensitivity,
      metadata: {
        relevance: result.relevance,
        novelty: result.novelty,
        intent: result.intent,
      },
    },
    attempts: 0,
    ts: Date.now(),
    fingerprint,
  });
  await db.fingerprints.put({ hash: fingerprint, ts: Date.now() });

  // Try immediate push
  flushQueue().catch(console.warn);
  return { ok: true, decision: 'queued' };
}

async function flushQueue(): Promise<void> {
  const pending = await db.queue.where('status').equals('pending').limit(10).toArray();
  for (const item of pending) {
    const result = await pushNode({ ...item.payload, fingerprint: item.fingerprint });
    if (result) {
      await db.queue.update(item.id!, { status: 'sent' });
    } else {
      const attempts = item.attempts + 1;
      if (attempts >= 5) {
        await db.queue.update(item.id!, { status: 'failed', attempts });
      } else {
        await db.queue.update(item.id!, { attempts });
      }
    }
  }
}
