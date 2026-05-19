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
 * Open the web app login in a new tab and wait for postMessage with the session.
 * Resolves to true on success, false on user cancel / timeout.
 */
export function startLoginFlow(): Promise<boolean> {
  return new Promise((resolve) => {
    const bridge = `${WEB_URL}/auth/extension-bridge?origin=${encodeURIComponent(
      chrome.runtime.getURL(''),
    )}`;
    const tab = window.open(bridge, '_blank');
    if (!tab) {
      resolve(false);
      return;
    }

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        window.removeEventListener('message', onMessage);
        resolve(false);
      }
    }, 5 * 60_000);

    async function onMessage(ev: MessageEvent) {
      if (!ev.data || typeof ev.data !== 'object') return;
      if ((ev.data as { type?: string }).type !== 'mesh-auth') return;
      const payload = ev.data as {
        type: 'mesh-auth';
        access_token: string;
        refresh_token: string;
        expires_in: number;
        user: { id: string; email: string };
      };
      await setAuth({
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
        expiresAt: Date.now() + payload.expires_in * 1000,
        userId: payload.user.id,
        email: payload.user.email,
      });
      resolved = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      try {
        tab?.close();
      } catch {
        /* ignore */
      }
      resolve(true);
    }

    window.addEventListener('message', onMessage);
  });
}

export async function signOut(): Promise<void> {
  await clearAuth();
  await db.queue.clear();
  await db.fingerprints.clear();
}
