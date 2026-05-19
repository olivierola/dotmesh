import { useEffect, useState } from 'react';
import { db, getSetting, setSetting } from '@/lib/db';
import { getAuth, startLoginFlow, signOut, type AuthState } from '@/lib/auth';

interface Stats {
  pending: number;
  sent: number;
  failed: number;
}

const WEB_URL =
  (import.meta.env.VITE_PUBLIC_WEB_URL as string | undefined) ?? 'https://dotmesh.vercel.app';

export function Popup() {
  const [stats, setStats] = useState<Stats>({ pending: 0, sent: 0, failed: 0 });
  const [paused, setPaused] = useState(false);
  const [recent, setRecent] = useState<
    Array<{ id: number; ts: number; text: string; status: string; source_app?: string }>
  >([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [auth, setAuthState] = useState<AuthState | null | undefined>(undefined);

  const reload = async () => {
    const [pending, sent, failed] = await Promise.all([
      db.queue.where('status').equals('pending').count(),
      db.queue.where('status').equals('sent').count(),
      db.queue.where('status').equals('failed').count(),
    ]);
    setStats({ pending, sent, failed });

    const recentRows = await db.queue.orderBy('ts').reverse().limit(5).toArray();
    setRecent(
      recentRows.map((r) => ({
        id: r.id!,
        ts: r.ts,
        text: r.payload.content.slice(0, 120),
        status: r.status,
        source_app: r.payload.source_app,
      })),
    );

    setPaused(await getSetting('paused', false));
    setLastError(await getSetting<string | null>('last_error', null));
    setAuthState((await getAuth()) ?? null);
  };

  useEffect(() => {
    void reload();
    // Poll while popup is open
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, []);

  const togglePause = async () => {
    const next = !paused;
    setPaused(next);
    await setSetting('paused', next);
  };

  const openDashboard = () => {
    chrome.tabs.create({ url: `${WEB_URL}/dashboard` });
  };

  const openHere = (path: string) => {
    chrome.tabs.create({ url: `${WEB_URL}${path}` });
  };

  const login = async () => {
    const ok = await startLoginFlow();
    if (ok) setAuthState(await getAuth());
  };

  const logout = async () => {
    await signOut();
    setAuthState(null);
  };

  const retryFailed = async () => {
    await db.queue
      .where('status')
      .equals('failed')
      .modify({ status: 'pending', attempts: 0 });
    void reload();
    chrome.runtime.sendMessage({ type: 'FLUSH_QUEUE' });
  };

  const clearFailed = async () => {
    await db.queue.where('status').equals('failed').delete();
    void reload();
  };

  if (auth === undefined) {
    return (
      <div className="mesh-popup">
        <p className="empty">Loading…</p>
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="mesh-popup">
        <header className="hdr">
          <h1>
            mesh<span className="dot">.</span>
          </h1>
        </header>
        <p className="muted">Sign in to start capturing memories from your browsing.</p>
        <button onClick={login} className="primary">
          Sign in with Mesh
        </button>
        <button onClick={openDashboard} className="secondary">
          Open Mesh website
        </button>
      </div>
    );
  }

  return (
    <div className="mesh-popup">
      <header className="hdr">
        <h1>
          mesh<span className="dot">.</span>
        </h1>
        <StatusBadge paused={paused} pending={stats.pending} failed={stats.failed} />
      </header>

      {/* Account row */}
      <div className="account">
        <div className="avatar">{(auth.email[0] ?? '?').toUpperCase()}</div>
        <div className="account-info">
          <div className="account-email">{auth.email}</div>
          <button onClick={logout} className="link-btn">
            Sign out
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="stats-grid">
        <Stat label="Captured" value={stats.sent} color="#a3e635" />
        <Stat label="Pending" value={stats.pending} color="#fbbf24" />
        <Stat label="Failed" value={stats.failed} color={stats.failed > 0 ? '#f87171' : '#525252'} />
      </div>

      {/* Failed banner with retry */}
      {stats.failed > 0 && (
        <div className="banner banner-error">
          <div className="banner-text">
            {stats.failed} item{stats.failed > 1 ? 's' : ''} failed to upload
            {lastError && <div className="banner-detail">{lastError}</div>}
          </div>
          <div className="banner-actions">
            <button onClick={retryFailed} className="link-btn">
              Retry
            </button>
            <button onClick={clearFailed} className="link-btn danger">
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Recent captures */}
      <section className="section">
        <div className="section-title">Recent</div>
        {recent.length === 0 ? (
          <div className="empty">
            Nothing captured yet.
            <br />
            Browse a long article or chat with an AI for &gt; 45 seconds.
          </div>
        ) : (
          <ul className="recent-list">
            {recent.map((r) => (
              <li key={r.id} className="recent-item">
                <div className="recent-meta">
                  <span className={`dot-status status-${r.status}`} />
                  <span className="recent-time">
                    {new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {r.source_app && <span className="recent-source">{r.source_app}</span>}
                </div>
                <div className="recent-text">{r.text}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Actions */}
      <div className="actions">
        <button onClick={togglePause} className={paused ? 'primary' : 'secondary'}>
          {paused ? '▶ Resume capture' : '⏸ Pause capture'}
        </button>
        <div className="action-row">
          <button onClick={openDashboard} className="link-btn">
            Dashboard
          </button>
          <button onClick={() => openHere('/collections')} className="link-btn">
            Collections
          </button>
          <button
            onClick={() =>
              chrome.tabs.create({ url: chrome.runtime.getURL('/diagnostic.html') })
            }
            title="Open diagnostics page"
            className="link-btn"
          >
            Diagnostics
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({
  paused,
  pending,
  failed,
}: {
  paused: boolean;
  pending: number;
  failed: number;
}) {
  if (paused) return <span className="badge badge-warn">Paused</span>;
  if (failed > 0) return <span className="badge badge-error">Issue</span>;
  if (pending > 0) return <span className="badge badge-info">Syncing</span>;
  return <span className="badge badge-ok">Active</span>;
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-value" style={{ color }}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
