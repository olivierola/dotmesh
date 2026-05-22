import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';

/**
 * Auth callback landing page. Two flows can arrive here:
 *
 *   1. Magic link click — implicit flow. The URL carries the session
 *      in its hash (`#access_token=...&refresh_token=...`). The
 *      Supabase JS client detects it automatically via
 *      detectSessionInUrl, but the detection happens asynchronously
 *      after mount. We can't rely on a single getSession() — it
 *      returns null when called too eagerly.
 *
 *   2. OAuth callback — code in `?code=`. Requires explicit
 *      exchangeCodeForSession() to swap the code for a session.
 *
 * The fix is to subscribe to onAuthStateChange and only redirect when
 * we actually observe a SIGNED_IN event (or already have a session).
 * That handles both flows uniformly and avoids the black-screen race
 * where the page navigates back to /login before the client has had
 * time to parse the hash.
 */
export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'pending' | 'redirecting' | 'error'>(
    'pending',
  );

  useEffect(() => {
    let cancelled = false;
    let watchdog: number | undefined;

    const safeNext = (() => {
      const raw = params.get('next');
      if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard';
      return raw;
    })();

    const finalize = (path: string) => {
      if (cancelled) return;
      setStatus('redirecting');
      navigate(path, { replace: true });
    };

    // 1. If we already have a session at mount, redirect immediately.
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) finalize(safeNext);
    });

    // 2. OAuth PKCE path — explicit code exchange.
    const code = params.get('code');
    if (code) {
      supabase.auth
        .exchangeCodeForSession(window.location.href)
        .then(({ error: ex }) => {
          if (cancelled) return;
          if (ex) {
            setError(ex.message);
            setStatus('error');
          }
        })
        .catch((e: Error) => {
          if (cancelled) return;
          setError(e.message);
          setStatus('error');
        });
    }

    // 3. Subscribe to auth events — this is what catches magic-link
    //    implicit-flow signs once the SDK has finished parsing the hash.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
        finalize(safeNext);
      }
    });

    // 4. Watchdog — if 8s pass without a session AND no error path
    //    triggered, surface a recoverable error instead of an
    //    infinite spinner / black screen.
    watchdog = window.setTimeout(() => {
      if (cancelled) return;
      supabase.auth.getSession().then(({ data }) => {
        if (cancelled) return;
        if (data.session) {
          finalize(safeNext);
        } else if (status !== 'redirecting') {
          setError(
            "Sign-in didn't complete. Open this link in the same browser where you started, or try again.",
          );
          setStatus('error');
        }
      });
    }, 8000);

    return () => {
      cancelled = true;
      if (watchdog) clearTimeout(watchdog);
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, params]);

  return (
    <div className="grid h-full min-h-screen place-items-center bg-neutral-950 px-6 text-neutral-100">
      {status === 'error' && error ? (
        <div className="max-w-md rounded-lg border border-red-900 bg-red-950/30 p-5 text-center text-sm text-red-300">
          <p className="mb-3 font-medium">Sign-in failed.</p>
          <p className="mb-4 text-xs text-red-400">{error}</p>
          <button
            onClick={() => navigate('/login', { replace: true })}
            className="rounded-md border border-red-800 px-3 py-1.5 text-xs text-red-200 hover:bg-red-950"
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="text-center">
          <div className="mx-auto mb-3 h-10 w-10 animate-spin rounded-full border-2 border-neutral-700 border-t-accent" />
          <p className="text-sm text-neutral-400">
            {status === 'redirecting' ? 'Redirecting…' : 'Completing sign-in…'}
          </p>
        </div>
      )}
    </div>
  );
}
