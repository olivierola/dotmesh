import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';

/**
 * Signup page — creates a new Mesh account.
 *
 * Flow:
 *   1. User types email + optional display name
 *   2. We send a 6-digit OTP via Supabase (shouldCreateUser: true)
 *   3. User types the code from their inbox
 *   4. verifyOtp → session created → redirect to `?next=` or /onboarding
 */
export default function SignupPage() {
  const [params] = useSearchParams();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'verifying'>('idle');
  const [error, setError] = useState<string | null>(null);

  const next = useMemo(() => {
    const raw = params.get('next') ?? '/onboarding';
    if (!raw.startsWith('/') || raw.startsWith('//')) return '/onboarding';
    return raw;
  }, [params]);

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        data: displayName.trim() ? { display_name: displayName.trim() } : undefined,
      },
    });
    setStatus('idle');
    if (err) {
      setError(err.message);
    } else {
      setStep('code');
    }
  };

  const verifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('verifying');
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    });
    if (err) {
      setStatus('idle');
      setError(err.message);
    } else {
      window.location.href = next;
    }
  };

  const oauth = async (provider: 'google' | 'github' | 'apple') => {
    setError(null);
    const redirectUrl = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: redirectUrl },
    });
    if (err) setError(err.message);
  };

  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center px-6">
      <h1 className="mb-2 text-2xl font-semibold">Create your Mesh account</h1>
      <p className="mb-8 text-sm text-neutral-400">EU-hosted · Free forever for hobby use</p>

      {step === 'email' && (
        <>
          <div className="w-full space-y-3">
            <button
              onClick={() => oauth('google')}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm text-neutral-100 hover:border-neutral-600"
            >
              <GoogleIcon /> Sign up with Google
            </button>
            <button
              onClick={() => oauth('github')}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm text-neutral-100 hover:border-neutral-600"
            >
              <GitHubIcon /> Sign up with GitHub
            </button>
            <button
              onClick={() => oauth('apple')}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-sm text-neutral-100 hover:border-neutral-600"
            >
              <AppleIcon /> Sign up with Apple
            </button>
          </div>

          <div className="my-6 flex w-full items-center gap-3 text-xs text-neutral-500">
            <div className="h-px flex-1 bg-neutral-800" />
            or with email
            <div className="h-px flex-1 bg-neutral-800" />
          </div>

          <form onSubmit={sendCode} className="flex w-full flex-col gap-3">
            <input
              type="text"
              placeholder="Your name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={80}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm placeholder-neutral-600 focus:border-accent focus:outline-none"
            />
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm placeholder-neutral-600 focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={status === 'sending' || !email}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
            >
              {status === 'sending' ? 'Sending code…' : 'Send 6-digit code'}
            </button>
          </form>
        </>
      )}

      {step === 'code' && (
        <form onSubmit={verifyCode} className="flex w-full flex-col gap-3">
          <p className="text-xs text-neutral-400">
            We sent a 6-digit code to <strong>{email}</strong>. Enter it below to finish creating
            your account.
          </p>
          <input
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
            placeholder="••••••"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
            className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-center font-mono text-lg tracking-[0.5em] placeholder-neutral-700 focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={status === 'verifying' || code.length !== 6}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
          >
            {status === 'verifying' ? 'Verifying…' : 'Create account'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('email');
              setCode('');
              setError(null);
            }}
            className="text-xs text-neutral-500 hover:text-neutral-300"
          >
            Use a different email
          </button>
        </form>
      )}

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}

      <p className="mt-8 text-xs text-neutral-500">
        Already have an account?{' '}
        <Link to={`/login${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`} className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
      <p className="mt-4 text-[10px] text-neutral-600">
        By signing up you agree to our Terms and Privacy policy.
      </p>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M21.35 11.1h-9.17v2.92h5.27c-.23 1.38-1.62 4.06-5.27 4.06-3.18 0-5.77-2.63-5.77-5.88s2.59-5.88 5.77-5.88c1.81 0 3.02.77 3.71 1.43l2.53-2.43C16.65 3.93 14.6 3 12.18 3 6.93 3 2.68 7.25 2.68 12.5S6.93 22 12.18 22c7.04 0 9.34-4.95 9.34-7.5 0-.5-.05-.9-.17-1.4z" />
    </svg>
  );
}
function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.34c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.72-.49.06-.48.06-.48.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.66 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}
function AppleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M11.182.008C11.148-.03 9.923.023 8.857 1.18 7.79 2.337 7.953 3.66 7.977 3.69c.024.03 1.514.083 2.48-1.265.967-1.347.748-2.376.725-2.417zm3.314 11.733c-.048-.096-2.325-1.234-2.113-3.422.212-2.189 1.675-2.789 1.698-2.854.023-.065-.597-.79-1.254-1.157a3.692 3.692 0 0 0-1.563-.434c-.108-.003-.483-.095-1.254.116-.508.139-1.653.589-1.968.607-.316.018-1.256-.522-2.267-.665-.647-.125-1.333.131-1.824.328-.49.196-1.422.754-2.074 2.237-.652 1.482-.311 3.83-.067 4.56.244.729.625 1.924 1.273 2.796.576.984 1.34 1.667 1.659 1.899.319.232 1.219.386 1.843.067.502-.308 1.408-.485 1.766-.472.357.013 1.061.154 1.782.539.571.197 1.111.115 1.652-.105.541-.221 1.324-1.059 2.238-2.758.347-.79.505-1.217.473-1.282z" />
    </svg>
  );
}
