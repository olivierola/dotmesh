/**
 * Lightweight trigger scorer for cross-agent injection.
 *
 * Decision: should we even call /inject for this query?
 *
 *   - Skip if too short (< 8 chars)
 *   - Skip on trivial command-like queries
 *   - If the user has ANY enabled custom instructions, always proceed
 *     (server-side embedding match decides whether to inject) — global
 *     instructions like "always answer in French" don't share keywords
 *     with arbitrary prompts.
 *   - Otherwise, fuzzy-match query words against the user's recent
 *     entity/tag set to avoid a wasted round-trip when there's clearly
 *     no relevant memory.
 *
 * Caches refreshed every 10 min in the background.
 */

import { db, getSetting, setSetting } from './db';
import {
  fetchRecentNodeKeywords,
  fetchHasEnabledInstructions,
} from './api-client';

const TRIVIAL_PATTERNS = [
  /^(what|whats)\s+(time|date)/i,
  /^translate /i,
  /^spell\s?(check)? /i,
  /^summarize this:?$/i,
  /^hi$/i,
  /^hello$/i,
  /^thanks?$/i,
  /^lol$/i,
];

const REFRESH_INTERVAL_MS = 10 * 60_000;

interface CachedKeywords {
  list: string[];
  fetchedAt: number;
}

async function getCachedKeywords(): Promise<string[]> {
  const cur = await getSetting<CachedKeywords | null>('recent_keywords', null);
  if (cur && Date.now() - cur.fetchedAt < REFRESH_INTERVAL_MS) {
    return cur.list;
  }
  const fresh = await fetchRecentNodeKeywords();
  await setSetting('recent_keywords', { list: fresh, fetchedAt: Date.now() } as CachedKeywords);
  return fresh;
}

interface CachedInstructionFlag {
  has: boolean;
  fetchedAt: number;
}

async function userHasInstructions(): Promise<boolean> {
  const cur = await getSetting<CachedInstructionFlag | null>('has_instructions', null);
  if (cur && Date.now() - cur.fetchedAt < REFRESH_INTERVAL_MS) {
    return cur.has;
  }
  const fresh = await fetchHasEnabledInstructions();
  await setSetting('has_instructions', { has: fresh, fetchedAt: Date.now() } as CachedInstructionFlag);
  return fresh;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

export async function shouldAttemptInjection(query: string): Promise<{
  ok: boolean;
  reason: string;
}> {
  if (!query || query.length < 8) return { ok: false, reason: 'too_short' };
  if (TRIVIAL_PATTERNS.some((re) => re.test(query.trim()))) {
    return { ok: false, reason: 'trivial' };
  }

  // Instructions are a strong signal that the server should always be
  // consulted: a global directive like "always answer in French" won't
  // share keywords with arbitrary prompts. The semantic matcher decides
  // whether it actually applies.
  if (await userHasInstructions()) {
    return { ok: true, reason: 'has_instructions' };
  }

  const keywords = await getCachedKeywords();
  if (keywords.length === 0) {
    // Cold start — no memory yet; let the server decide.
    return { ok: true, reason: 'cold_start' };
  }

  const queryTokens = new Set(tokenize(query));
  for (const k of keywords) {
    for (const t of tokenize(k)) {
      if (queryTokens.has(t)) {
        return { ok: true, reason: `matched:${t}` };
      }
    }
  }
  return { ok: false, reason: 'no_keyword_overlap' };
}

/** Background flush: refresh cached keywords + instruction-presence flag. */
export async function refreshKeywordsIfStale(): Promise<void> {
  const cur = await getSetting<CachedKeywords | null>('recent_keywords', null);
  if (!cur || Date.now() - cur.fetchedAt >= REFRESH_INTERVAL_MS) {
    const fresh = await fetchRecentNodeKeywords();
    await setSetting('recent_keywords', { list: fresh, fetchedAt: Date.now() } as CachedKeywords);
  }
  const curFlag = await getSetting<CachedInstructionFlag | null>('has_instructions', null);
  if (!curFlag || Date.now() - curFlag.fetchedAt >= REFRESH_INTERVAL_MS) {
    const has = await fetchHasEnabledInstructions();
    await setSetting('has_instructions', { has, fetchedAt: Date.now() } as CachedInstructionFlag);
  }
}

void db; // tree-shake guard
