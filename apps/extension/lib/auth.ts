/**
 * Extension auth flow.
 *
 * Strategy: the popup opens a Mesh web URL `/auth/extension-bridge` in a new tab.
 * That page reads the current Supabase session and posts it back to our window
 * via window.opener.postMessage. We receive it in the popup, persist into
 * IndexedDB, and the background worker picks it up for API calls.
 *
 * Token refresh: when access_token is < 60s from expiry, we refresh in-place by
 * calling Supabase /auth/v1/token?grant_type=refresh_token.
 */

import { db, getSetting, setSetting } from './db';

export interface AuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  userId: string;
  email: string;
}

const WEB_URL =
  (import.meta.env.VITE_PUBLIC_WEB_URL as string | undefined) ?? 'http://localhost:5173';
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';

export async function getAuth(): Promise<AuthState | null> {
  return getSetting<AuthState | null>('auth', null);
}

export async function setAuth(auth: AuthState | null): Promise<void> {
  await setSetting('auth', auth);
}

export async function clearAuth(): Promise<void> {
  await setSetting('auth', null);
}

/**
 * Refreshes the access token if within 60s of expiry.
 * Returns the (possibly refreshed) auth state, or null if refresh failed.
 */
export async function ensureFreshAuth(): Promise<AuthState | null> {
  const auth = await getAuth();
  if (!auth) return null;
  if (auth.expiresAt > Date.now() + 60_000) return auth;
  return refreshNow(auth);
}

/**
 * Force a refresh regardless of expiry — used when the server returns
 * 401 with an "asymmetric jwt" / "invalid jwt" message, which happens
 * after Supabase rotates its JWKS in the background. Returns null when
 * the refresh_token itself is dead (i.e. the user must really re-login).
 */
export async function forceRefreshAuth(): Promise<AuthState | null> {
  const auth = await getAuth();
  if (!auth) return null;
  return refreshNow(auth);
}

async function refreshNow(auth: AuthState): Promise<AuthState | null> {
  if (!SUPABASE_URL) return auth;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        apikey: (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: auth.refreshToken }),
    });
    if (!res.ok) {
      console.warn('[Mesh] token refresh failed', res.status);
      // 400/401 here means the refresh_token is no longer accepted —
      // re-login required. Return null so the caller knows.
      if (res.status === 400 || res.status === 401) return null;
      return auth;
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const next: AuthState = {
      ...auth,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    await setAuth(next);
    return next;
  } catch (e) {
    console.warn('[Mesh] token refresh error', e);
    return auth;
  }
}

/**
 * Open the web app's extension-bridge in a new tab. The bridge page posts a
 * `mesh-auth` message which is intercepted by our content script (bridge-content)
 * and forwarded to the background worker via chrome.runtime.sendMessage. The
 * background writes the session to IndexedDB.
 *
 * We then poll `getAuth()` until it becomes non-null (success) or we time out.
 * No reliance on window.opener — the extension popup typically closes before
 * the new tab finishes loading, which used to break the old postMessage flow.
 */
export function startLoginFlow(): Promise<boolean> {
  return new Promise((resolve) => {
    const bridge = `${WEB_URL}/auth/extension-bridge?origin=${encodeURIComponent(
      chrome.runtime.getURL(''),
    )}`;

    // Wipe any stale credentials first so the new login replaces them cleanly.
    void clearAuth();

    try {
      chrome.tabs.create({ url: bridge });
    } catch {
      // Fallback: window.open works from a popup context too, even if no opener.
      window.open(bridge, '_blank');
    }

    const startedAt = Date.now();
    const TIMEOUT_MS = 5 * 60_000;
    const intervalId = setInterval(async () => {
      const auth = await getAuth();
      if (auth) {
        clearInterval(intervalId);
        resolve(true);
        return;
      }
      if (Date.now() - startedAt > TIMEOUT_MS) {
        clearInterval(intervalId);
        resolve(false);
      }
    }, 800);
  });
}

export async function signOut(): Promise<void> {
  await clearAuth();
  await db.queue.clear();
  await db.fingerprints.clear();
}
