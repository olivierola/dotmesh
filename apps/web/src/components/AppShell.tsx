import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { supabase } from '@/lib/supabase';
import { api } from '@/lib/api-client';
import { useRealtimeNotifications } from '@/hooks/useRealtimeNotifications';
import { displayForNode } from '@/lib/node-display';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: '🏠' },
  { to: '/assistant', label: 'Assistant', icon: '🧠' },
  { to: '/timeline', label: 'Timeline', icon: '🗂' },
  { to: '/notes', label: 'Notes', icon: '📝' },
  { to: '/collections', label: 'Collections', icon: '📚' },
  { to: '/instructions', label: 'Instructions', icon: '📜' },
  { to: '/graph', label: 'Graph', icon: '🕸' },
  { to: '/rules', label: 'Rules', icon: '🛡' },
  { to: '/connectors', label: 'Connectors', icon: '🔗' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
];

const LABEL_BY_PATH: Record<string, string> = Object.fromEntries(NAV.map((n) => [n.to, n.label]));

export default function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [email, setEmail] = useState<string>('');
  const { newCount, reset: resetNotifications } = useRealtimeNotifications();

  // Auto-close drawer on route change (mobile)
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Clear the notification badge when the user navigates to Timeline.
  useEffect(() => {
    if (location.pathname === '/timeline') resetNotifications();
  }, [location.pathname, resetNotifications]);

  // Read the signed-in user and keep it in sync with auth state changes.
  useEffect(() => {
    if (api.isMock) {
      setEmail('dev@local');
      return;
    }
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? '');
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? '');
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Cmd/Ctrl+K opens the global search palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const signOut = async () => {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn('signOut failed', e);
    }
    // Clear local onboarding flag so the new user gets the onboarding flow.
    localStorage.removeItem('mesh:onboarded');
    // Replace navigation so the protected page is not in the back stack.
    navigate('/login', { replace: true });
  };

  const crumb = LABEL_BY_PATH[location.pathname] ?? '';

  return (
    <div className="flex h-full bg-neutral-950 text-neutral-100">
      {/* Mobile backdrop */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Sidebar — static on >= md, drawer on < md */}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-neutral-900 bg-neutral-950 p-4 transition-transform duration-200 md:static md:w-56 md:translate-x-0',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <NavLink to="/" className="mb-8 flex items-center gap-1 text-lg font-semibold tracking-tight">
          mesh<span className="text-accent">.</span>
        </NavLink>

        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-neutral-900 text-white'
                    : 'text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200',
                )
              }
            >
              <span className="w-4 text-center text-base leading-none">{n.icon}</span>
              <span className="flex-1">{n.label}</span>
              {n.to === '/timeline' && newCount > 0 && (
                <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  +{newCount > 9 ? '9+' : newCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto border-t border-neutral-900 pt-4">
          <div className="mb-2 flex items-center gap-2 rounded-md px-3 py-2">
            <Avatar email={email || 'signing in…'} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-neutral-300">
                {email || 'signing in…'}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-500">Free</div>
            </div>
          </div>
          <button
            onClick={signOut}
            className="block w-full rounded-md px-3 py-1.5 text-left text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Top bar + content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-3 border-b border-neutral-900 bg-neutral-950 px-4 py-3 text-sm md:px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="rounded-md border border-neutral-800 p-1.5 text-neutral-300 hover:border-neutral-700 md:hidden"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </button>
            <Breadcrumb crumb={crumb} />
          </div>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-400 hover:border-neutral-700"
          >
            <span>🔍</span>
            <span className="hidden sm:inline">Search anything…</span>
            <kbd className="hidden rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-[10px] text-neutral-500 sm:inline">
              ⌘K
            </kbd>
          </button>
        </header>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

function Breadcrumb({ crumb }: { crumb: string }) {
  return (
    <nav className="flex items-center gap-2 text-xs text-neutral-500">
      <span>Mesh</span>
      {crumb && (
        <>
          <span>/</span>
          <span className="text-neutral-300">{crumb}</span>
        </>
      )}
    </nav>
  );
}

function Avatar({ email }: { email: string }) {
  const initials = email.split('@')[0]?.slice(0, 2).toUpperCase() ?? '??';
  return (
    <div className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-accent to-accent-700 text-[10px] font-semibold text-white">
      {initials}
    </div>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<{ id: string; label: string; subtitle: string }>>([]);

  useEffect(() => {
    if (!q.trim()) {
      // show nav suggestions
      setResults(NAV.map((n) => ({ id: n.to, label: n.label, subtitle: `Go to ${n.to}` })));
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.search(q, 8);
        if (cancelled) return;
        setResults(
          data.results.map((r) => {
            // The search result row has the same shape as MockNode for the
            // fields the display helper actually reads.
            const display = displayForNode(r as unknown as Parameters<typeof displayForNode>[0]);
            return {
              id: r.id,
              label: display.title,
              subtitle: display.subtitle ?? r.source,
            };
          }),
        );
      } catch {
        if (!cancelled) setResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [q]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="mx-auto mt-24 w-full max-w-lg overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search memories, navigate…"
          className="w-full border-b border-neutral-800 bg-transparent px-4 py-3 text-sm placeholder-neutral-600 focus:outline-none"
        />
        <ul className="max-h-96 overflow-y-auto">
          {results.length === 0 ? (
            <li className="p-4 text-center text-xs text-neutral-500">No results.</li>
          ) : (
            results.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => {
                    if (r.id.startsWith('/')) navigate(r.id);
                    else navigate('/timeline');
                    onClose();
                  }}
                  className="block w-full px-4 py-2.5 text-left text-sm hover:bg-neutral-900"
                >
                  <div className="text-neutral-100">{r.label}</div>
                  <div className="text-xs text-neutral-500">{r.subtitle}</div>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="border-t border-neutral-900 px-4 py-2 text-[10px] text-neutral-600">
          ↑↓ navigate · ↵ open · esc close
        </div>
      </div>
    </div>
  );
}
