import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import LandingPage from '@/pages/Landing';
import LoginPage from '@/pages/Login';
import SignupPage from '@/pages/Signup';
import AuthCallbackPage from '@/pages/AuthCallback';
import TimelinePage from '@/pages/Timeline';
import SearchPage from '@/pages/Search';
import GraphPage from '@/pages/Graph';
import SettingsPage from '@/pages/Settings';
import RulesPage from '@/pages/Rules';
import ConnectorsPage from '@/pages/Connectors';
import OnboardingPage from '@/pages/Onboarding';
import InsightsPage from '@/pages/Insights';
import DashboardPage from '@/pages/Dashboard';
import AssistantPage from '@/pages/Assistant';
import SlackChannelsPage from '@/pages/SlackChannels';
import WebhooksPage from '@/pages/Webhooks';
import EmbedSettingsPage from '@/pages/EmbedSettings';
import EmbedAskPage from '@/pages/EmbedAsk';
import ExtensionBridgePage from '@/pages/ExtensionBridge';
import CollectionsPage from '@/pages/Collections';
import AppShell from '@/components/AppShell';

/**
 * Reactive session hook — listens to Supabase auth events and exposes
 * `{ session, loading }` so guards can wait for the initial fetch before
 * deciding to redirect.
 */
function useSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      if (!mounted) return;
      setSession(s);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}

/**
 * Auth-protected shell for the app interior.
 * - While the initial session check is loading, render nothing (avoid flashes).
 * - If no session, redirect to /login?next=<current path> so the user lands back
 *   on the page they originally requested after signing in.
 * - Otherwise wrap children with the onboarding gate + AppShell.
 */
function Shell({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession();
  const location = useLocation();

  if (loading) {
    return <div className="grid h-full place-items-center" />;
  }

  if (!session) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  return (
    <OnboardingGate>
      <AppShell>{children}</AppShell>
    </OnboardingGate>
  );
}

/**
 * Redirects to /onboarding if the user has never completed it.
 * Tracked via localStorage (mirror of users.onboarding_completed_at).
 */
function OnboardingGate({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [checked, setChecked] = useState(false);

  useEffect(() => setChecked(true), []);

  if (!checked) return null;
  if (location.pathname.startsWith('/onboarding')) return <>{children}</>;

  const done = typeof window !== 'undefined' && localStorage.getItem('mesh:onboarded');
  if (!done) return <Navigate to="/onboarding" replace />;

  return <>{children}</>;
}

/**
 * Inverse guard for the public auth pages.
 * If a user is already signed in and tries to visit /login, send them to /dashboard.
 */
function PublicOnly({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession();
  if (loading) return null;
  if (session) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      {/* Public marketing */}
      <Route path="/" element={<LandingPage />} />

      {/* Auth flows — public, redirect away if already signed in */}
      <Route
        path="/login"
        element={
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        }
      />
      <Route
        path="/signup"
        element={
          <PublicOnly>
            <SignupPage />
          </PublicOnly>
        }
      />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />

      {/* Onboarding sits behind the same auth gate as the rest */}
      <Route
        path="/onboarding"
        element={
          <RequireAuth>
            <OnboardingPage />
          </RequireAuth>
        }
      />

      {/* Protected app */}
      <Route path="/dashboard" element={<Shell><DashboardPage /></Shell>} />
      <Route path="/assistant" element={<Shell><AssistantPage /></Shell>} />
      <Route path="/timeline" element={<Shell><TimelinePage /></Shell>} />
      <Route path="/collections" element={<Shell><CollectionsPage /></Shell>} />
      <Route path="/search" element={<Shell><SearchPage /></Shell>} />
      <Route path="/graph" element={<Shell><GraphPage /></Shell>} />
      <Route path="/insights" element={<Shell><InsightsPage /></Shell>} />
      <Route path="/rules" element={<Shell><RulesPage /></Shell>} />
      <Route path="/connectors" element={<Shell><ConnectorsPage /></Shell>} />
      <Route path="/connectors/slack/channels" element={<Shell><SlackChannelsPage /></Shell>} />
      <Route path="/webhooks" element={<Shell><WebhooksPage /></Shell>} />
      <Route path="/embed" element={<Shell><EmbedSettingsPage /></Shell>} />
      <Route path="/settings" element={<Shell><SettingsPage /></Shell>} />

      {/* Public embed widget — no shell, no auth */}
      <Route path="/embed/ask" element={<EmbedAskPage />} />

      {/* Bridge page for the browser extension to fetch the current session */}
      <Route path="/auth/extension-bridge" element={<ExtensionBridgePage />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/**
 * Lighter wrapper for pages that need auth but no AppShell (e.g. /onboarding).
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return null;
  if (!session) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}
