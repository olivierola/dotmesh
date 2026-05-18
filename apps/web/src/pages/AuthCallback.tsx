import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';

/**
 * Lands here after:
 *   - Magic-link click (hash params: access_token, refresh_token, expires_in, …)
 *   - OAuth callback (Google/GitHub/Apple — uses PKCE `?code=`)
 *
 * Supabase JS handles both automatically:
 *   - `detectSessionInUrl: true` (set in lib/supabase.ts) absorbs hash params on load
 *   - For PKCE flow we call `exchangeCodeForSession()` explicitly
 *
 * After the session is established, we honor `?next=` (sanitized to internal paths only)
 * or fall back to /dashboard.
 */
export default function AuthCallbackPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const finalize = (path: string) => {
      if (!cancelled) navigate(path, { replace: true });
    };

    const safeNext = (() => {
      const raw = params.get('next');
      if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard';
      return raw;
    })();

    (async () => {
      // PKCE / OAuth path: explicit code-for-session exchange
      const code = params.get('code');
      if (code) {
        const { error: ex } = await supabase.auth.exchangeCodeForSession(
          window.location.href,
        );
        if (ex) {
          setError(ex.message);
          return;
        }
      }

      // For magic links the session is auto-parsed from the URL hash on page load.
      // We just need to read it back.
      const { data, error: getErr } = await supabase.auth.getSession();
      if (getErr) {
        setError(getErr.message);
        return;
      }
      if (data.session) {
        finalize(safeNext);
      } else {
        // No session and no recoverable code → back to login
        finalize('/login');
      }
    })().catch((e) => {
      if (!cancelled) setError((e as Error).message);
    });

    return () => {
      cancelled = true;
    };
  }, [navigate, params]);

  return (
    <div className="grid h-full place-items-center px-6">
      {error ? (
        <div className="max-w-md rounded-lg border border-red-900 bg-red-950/30 p-4 text-center text-sm text-red-300">
          <p className="mb-3">Sign-in failed.</p>
          <p className="mb-3 text-xs text-red-400">{error}</p>
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
          <p className="text-sm text-neutral-400">Completing sign-in…</p>
        </div>
      )}
    </div>
  );
}
