/**
 * Browsing session tracker.
 *
 * A session is a sliding 20-minute window. Every capture extends it, and
 * carries a `session_id` so process-node can wire `same_session` edges
 * between memories captured close together in time.
 *
 * Implementation: a single row in chrome.storage.local. We do not persist
 * past sessions — once the window expires we mint a new id.
 *
 * Why a sliding window rather than tab/visit lifecycle: users hop across
 * tabs and windows while reading. What matters for the "second brain" is
 * temporal coherence ("these captures happened while I was researching X"),
 * not browser-level identity.
 */

const SESSION_TTL_MS = 20 * 60 * 1000;
const STORAGE_KEY = 'mesh:nav_session';

interface SessionRow {
  id: string;
  last_at: number;
  last_url: string | null;
}

function newId(): string {
  // crypto.randomUUID is available in MV3 service workers and content scripts.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function read(): Promise<SessionRow | null> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      resolve((res?.[STORAGE_KEY] as SessionRow | undefined) ?? null);
    });
  });
}

async function write(row: SessionRow): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: row }, () => resolve());
  });
}

/**
 * Return the current session (mint a new one if the previous expired).
 * Always extends `last_at` to now so the window slides.
 */
export async function touchSession(currentUrl: string | null): Promise<{
  session_id: string;
  previous_url: string | null;
  is_new: boolean;
}> {
  const now = Date.now();
  const prev = await read();
  if (!prev || now - prev.last_at > SESSION_TTL_MS) {
    const fresh: SessionRow = {
      id: newId(),
      last_at: now,
      last_url: currentUrl,
    };
    await write(fresh);
    return { session_id: fresh.id, previous_url: null, is_new: true };
  }
  const previous_url = prev.last_url;
  await write({ id: prev.id, last_at: now, last_url: currentUrl });
  return { session_id: prev.id, previous_url, is_new: false };
}
