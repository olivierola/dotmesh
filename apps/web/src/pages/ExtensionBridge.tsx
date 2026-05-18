import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * /auth/extension-bridge?origin=<chrome-extension://…>
 *
 * Loaded in a new tab by the Mesh browser extension. We read the current
 * Supabase session and broadcast it back to the parent window so the
 * extension can store it and start making authenticated API calls.
 *
 * If the user is not signed in, we send them to /login first then bounce back.
 */
export default function ExtensionBridgePage() {
  const [status, setStatus] = useState<'loading' | 'sent' | 'needs-login' | 'no-opener'>(
    'loading',
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;

      if (!session) {
        if (cancelled) return;
        setStatus('needs-login');
        // Bounce to /login then back here
        setTimeout(() => {
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
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

      if (window.opener && typeof window.opener.postMessage === 'function') {
        // The opener is the extension popup. Target origin '*' is required
        // because chrome-extension:// origins are not honored by all browsers.
        window.opener.postMessage(payload, '*');
        if (!cancelled) setStatus('sent');
        setTimeout(() => window.close(), 800);
      } else {
        if (!cancelled) setStatus('no-opener');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="grid h-full place-items-center bg-neutral-950 text-neutral-100">
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
        {status === 'no-opener' && (
          <p className="text-sm text-red-400">
            This page must be opened from the Mesh extension popup.
          </p>
        )}
      </div>
    </div>
  );
}
