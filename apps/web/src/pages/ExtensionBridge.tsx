import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * /auth/extension-bridge?origin=<chrome-extension://…>
 *
 * Loaded in a new tab by the Mesh browser extension. We read the current
 * Supabase session and post it to `window` — the extension's bridge-content
 * script intercepts it and forwards to the background worker.
 *
 * If the user is not signed in, we send them to /login first then bounce back.
 */
export default function ExtensionBridgePage() {
  const [status, setStatus] = useState<
    'loading' | 'sent' | 'needs-login' | 'no-extension'
  >('loading');

  useEffect(() => {
    let cancelled = false;
    let acked = false;

    function onAck(ev: MessageEvent) {
      if (ev.data?.type === 'mesh-auth-ack' && ev.data?.ok) {
        acked = true;
        if (!cancelled) setStatus('sent');
        setTimeout(() => window.close(), 1200);
      }
    }
    window.addEventListener('message', onAck);

    (async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;

      if (!session) {
        if (cancelled) return;
        setStatus('needs-login');
        setTimeout(() => {
          window.location.href = `/login?next=${encodeURIComponent(
            window.location.pathname + window.location.search,
          )}`;
        }, 800);
        return;
      }

      const payload = {
        type: 'mesh-auth',
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in ?? 3600,
        user: { id: session.user.id, email: session.user.email ?? '' },
      };

      // The content script attaches asynchronously; if we post once before it
      // mounts its listener, the message is lost. Repost every 400ms until we
      // get an ack, give up after ~10s.
      const startedAt = Date.now();
      const retry = setInterval(() => {
        if (acked || cancelled) {
          clearInterval(retry);
          return;
        }
        window.postMessage(payload, window.location.origin);
        if (Date.now() - startedAt > 10_000) {
          clearInterval(retry);
          if (!acked && !cancelled) setStatus('no-extension');
        }
      }, 400);
      // Immediate first attempt — covers the case where the content script
      // was already listening (extension installed before the tab was opened).
      window.postMessage(payload, window.location.origin);
    })();

    return () => {
      cancelled = true;
      window.removeEventListener('message', onAck);
    };
  }, []);

  return (
    <div className="grid h-full min-h-screen place-items-center bg-neutral-950 text-neutral-100">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-neutral-900/60 p-8 text-center">
        <div className="mb-4 text-2xl">🧠</div>
        {status === 'loading' && (
          <p className="text-sm text-neutral-400">Connecting extension to your account…</p>
        )}
        {status === 'sent' && (
          <p className="text-sm text-emerald-400">
            ✓ Extension linked. You can close this tab.
          </p>
        )}
        {status === 'needs-login' && (
          <p className="text-sm text-neutral-400">Redirecting you to sign in…</p>
        )}
        {status === 'no-extension' && (
          <p className="text-sm text-red-400">
            Could not reach the Mesh extension. Make sure it's installed and
            reload this tab.
          </p>
        )}
      </div>
    </div>
  );
}
