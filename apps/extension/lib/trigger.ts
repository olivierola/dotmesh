/**
 * Lightweight trigger scorer for cross-agent injection.
 *
 * Decision: should we even call /inject for this query?
 *
 *   - Skip if too short (< 8 chars)
 *   - Skip on trivial command-like queries
 *   - Otherwise, fuzzy-match query words against the user's recent entity/tag set
 *   - If any match found, proceed; else skip (saves a network round-trip)
 *
 * The recent keyword list is refreshed in the background every 10 minutes.
 */

import { db, getSetting, setSetting } from './db';
import { fetchRecentNodeKeywords } from './api-client';

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

/** Background flush: refresh keywords periodically. */
export async function refreshKeywordsIfStale(): Promise<void> {
  const cur = await getSetting<CachedKeywords | null>('recent_keywords', null);
  if (cur && Date.now() - cur.fetchedAt < REFRESH_INTERVAL_MS) return;
  const fresh = await fetchRecentNodeKeywords();
  await setSetting('recent_keywords', { list: fresh, fetchedAt: Date.now() } as CachedKeywords);
}

void db; // tree-shake guard
