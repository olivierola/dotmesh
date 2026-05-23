/**
 * Content script that runs ONLY on /auth/extension-bridge of the Mesh web app.
 *
 * It listens for the page's `window.postMessage({ type: 'mesh-auth', ... })`
 * and forwards it to the background worker via chrome.runtime.sendMessage.
 *
 * This replaces the old window.opener.postMessage flow, which was unreliable
 * because:
 *   - the extension popup closes the moment the new tab opens, killing the
 *     opener reference
 *   - Brave/Chrome COOP often nulls window.opener for cross-origin tabs
 */
import { defineContentScript } from 'wxt/sandbox';

export default defineContentScript({
  matches: [
    'https://dotmesh.vercel.app/auth/extension-bridge*',
    'http://localhost:5173/auth/extension-bridge*',
  ],
  runAt: 'document_start',
  main() {
    console.log('[Mesh bridge-content] listening for mesh-auth message');
    window.addEventListener('message', (ev) => {
      if (!ev.data || typeof ev.data !== 'object') return;
      if ((ev.data as { type?: string }).type !== 'mesh-auth') return;
      const payload = ev.data as {
        type: 'mesh-auth';
        access_token: string;
        refresh_token: string;
        expires_in: number;
        user: { id: string; email: string };
      };
      try {
        chrome.runtime.sendMessage(
          { type: 'EXT_AUTH_PAYLOAD', payload },
          (resp) => {
            // Tell the page it landed so it can close itself / show success.
            window.postMessage(
              { type: 'mesh-auth-ack', ok: Boolean(resp?.ok) },
              window.location.origin,
            );
          },
        );
      } catch (e) {
        console.warn('[Mesh bridge-content] sendMessage failed', e);
      }
    });
    // Signal readiness so the page knows the extension is present.
    window.postMessage({ type: 'mesh-auth-ready' }, window.location.origin);
  },
});
