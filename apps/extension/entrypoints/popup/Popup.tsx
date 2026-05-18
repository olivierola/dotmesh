import { useEffect, useState } from 'react';
import { db, getSetting, setSetting } from '@/lib/db';
import { getAuth, startLoginFlow, signOut, type AuthState } from '@/lib/auth';

interface Stats {
  pending: number;
  sent: number;
  failed: number;
}

export function Popup() {
  const [stats, setStats] = useState<Stats>({ pending: 0, sent: 0, failed: 0 });
  const [paused, setPaused] = useState(false);
  const [recent, setRecent] = useState<Array<{ ts: number; text: string }>>([]);
  const [auth, setAuthState] = useState<AuthState | null | undefined>(undefined);

  useEffect(() => {
    const load = async () => {
      const [pending, sent, failed] = await Promise.all([
        db.queue.where('status').equals('pending').count(),
        db.queue.where('status').equals('sent').count(),
        db.queue.where('status').equals('failed').count(),
      ]);
      setStats({ pending, sent, failed });

      const recentRows = await db.queue.orderBy('ts').reverse().limit(5).toArray();
      setRecent(
        recentRows.map((r) => ({
          ts: r.ts,
          text: r.payload.content.slice(0, 120),
        })),
      );

      setPaused(await getSetting('paused', false));
      setAuthState((await getAuth()) ?? null);
    };
    load();
  }, []);

  const togglePause = async () => {
    const next = !paused;
    setPaused(next);
    await setSetting('paused', next);
  };

  const openDashboard = () => {
    const url =
      (import.meta.env.VITE_PUBLIC_WEB_URL as string | undefined) ?? 'http://localhost:5173';
    chrome.tabs.create({ url: `${url}/dashboard` });
  };

  const login = async () => {
    const ok = await startLoginFlow();
    if (ok) setAuthState(await getAuth());
  };

  const logout = async () => {
    await signOut();
    setAuthState(null);
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
        <h1>
          mesh<span style={{ color: '#f5b301' }}>.</span>
        </h1>
        <p style={{ color: '#a3a3a3', fontSize: 12, marginTop: 8 }}>
          Sign in to start capturing memories.
        </p>
        <button onClick={login}>Sign in</button>
        <button onClick={openDashboard} className="secondary">
          Open Mesh
        </button>
      </div>
    );
  }

  return (
    <div className="mesh-popup">
      <h1>
        mesh<span style={{ color: '#f5b301' }}>.</span>
      </h1>

      <div className="stat">
        <span>Signed in as</span>
        <strong style={{ fontWeight: 400, fontSize: 11, color: '#a3a3a3' }}>
          {auth.email}
        </strong>
      </div>
      <div className="stat">
        <span>Captured</span>
        <strong>{stats.sent}</strong>
      </div>
      <div className="stat">
        <span>Pending</span>
        <strong>{stats.pending}</strong>
      </div>
      {stats.failed > 0 && (
        <div className="stat">
          <span style={{ color: '#f87171' }}>Failed</span>
          <strong>{stats.failed}</strong>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        {recent.length === 0 ? (
          <div className="empty">No captures yet. Browse a long article to test.</div>
        ) : (
          recent.map((r, i) => (
            <div key={i} className="item">
              <div className="item-meta">{new Date(r.ts).toLocaleTimeString()}</div>
              <div className="item-text">{r.text}</div>
            </div>
          ))
        )}
      </div>

      <button onClick={togglePause} className="secondary">
        {paused ? 'Resume capture' : 'Pause capture'}
      </button>
      <button onClick={openDashboard}>Open dashboard</button>
      <button onClick={logout} className="secondary" style={{ marginTop: 6 }}>
        Sign out
      </button>
    </div>
  );
}
