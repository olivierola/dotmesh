import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { Skeleton } from '@/components/Skeleton';

interface Prefs {
  notification_prefs: Record<string, boolean>;
  ui_prefs: Record<string, unknown>;
}

const NOTIF_LABELS: Array<{ key: string; label: string; hint: string }> = [
  {
    key: 'weekly_digest_email',
    label: 'Weekly digest email',
    hint: 'Monday morning summary of your week.',
  },
  {
    key: 'realtime_in_app',
    label: 'Realtime in-app notifications',
    hint: 'Badge in the sidebar when a new memory is captured.',
  },
  {
    key: 'product_updates',
    label: 'Product updates',
    hint: 'New features and improvements. ~1 email per month.',
  },
  {
    key: 'security_alerts',
    label: 'Security alerts',
    hint: 'Important account & security events. Strongly recommended.',
  },
];

export default function SettingsPage() {
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);

  useEffect(() => {
    api.loadPrefs().then(setPrefs).catch((e) => {
      console.warn('prefs load failed', e);
    });
  }, []);

  const togglePref = async (key: string) => {
    if (!prefs) return;
    const next = !prefs.notification_prefs[key];
    setPrefs({
      ...prefs,
      notification_prefs: { ...prefs.notification_prefs, [key]: next },
    });
    try {
      await api.updatePrefs({ notification_prefs: { [key]: next } });
    } catch (e) {
      setMessage({ kind: 'error', text: `Could not save: ${(e as Error).message}` });
    }
  };

  const [clustering, setClustering] = useState(false);
  const recluster = async () => {
    if (
      !confirm(
        'Re-cluster your memories into ~8 thematic groups via AI? Replaces previous 🎯 auto-clusters.',
      )
    ) {
      return;
    }
    setClustering(true);
    setMessage(null);
    try {
      const r = await api.clusterNodes(8);
      if (!r.ok) {
        setMessage({
          kind: 'error',
          text: r.reason === 'not_enough_embedded_nodes'
            ? `Need at least ${r.needed} embedded memories — only ${r.node_count} are ready.`
            : 'Clustering failed.',
        });
      } else {
        setMessage({
          kind: 'ok',
          text: `Built ${r.clusters_created} clusters from ${r.node_count} memories (wiped ${r.old_wiped} old). Check Collections.`,
        });
      }
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally {
      setClustering(false);
    }
  };

  const [cleaning, setCleaning] = useState(false);
  const cleanupTitles = async () => {
    if (!confirm('Re-run LLM cleanup on up to 100 memories with raw URLs / missing titles?')) return;
    setCleaning(true);
    setMessage(null);
    try {
      const r = await api.reprocessAll();
      setMessage({
        kind: 'ok',
        text: `Scanned ${r.scanned}, cleaned ${r.processed} (${r.embedded} re-embedded). Run again for the next batch.`,
      });
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally {
      setCleaning(false);
    }
  };

  const exportData = async () => {
    setExporting(true);
    setMessage(null);
    try {
      const blob = await api.exportAccount();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mesh-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage({ kind: 'ok', text: 'Export downloaded.' });
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally {
      setExporting(false);
    }
  };

  const deleteAccount = async () => {
    setDeleting(true);
    setMessage(null);
    try {
      const res = await api.deleteAccount();
      setMessage({
        kind: 'ok',
        text: `Scheduled. Hard wipe at ${new Date(res.hard_delete_at).toLocaleString()}.`,
      });
      setConfirmDelete(false);
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    } finally {
      setDeleting(false);
    }
  };

  const openBillingPortal = async () => {
    try {
      const { url } = await api.billingPortal();
      window.location.href = url;
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    }
  };

  const upgrade = async (tier: 'personal' | 'pro') => {
    try {
      const { url } = await api.billingCheckout({ tier, interval: 'month' });
      window.location.href = url;
    } catch (e) {
      setMessage({ kind: 'error', text: (e as Error).message });
    }
  };

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-semibold">Settings</h1>
      <p className="mb-6 text-xs text-amber-400/80">
        Dev mode — billing requires Stripe keys + a real backend.
      </p>

      {message && (
        <div
          className={`mb-4 rounded-md border p-3 text-sm ${
            message.kind === 'ok'
              ? 'border-emerald-900 bg-emerald-950/30 text-emerald-300'
              : 'border-red-900 bg-red-950/30 text-red-400'
          }`}
        >
          {message.text}
        </div>
      )}

      <section className="mb-6 rounded-md border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-neutral-400">
          Account
        </h2>
        <p className="text-sm text-neutral-200">dev@local</p>
        <p className="mt-1 text-xs text-neutral-500">Region: EU (Frankfurt) · Locale: fr</p>
      </section>

      <section className="mb-6 rounded-md border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-400">
          Plan
        </h2>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-base font-medium text-neutral-100">Free</div>
            <div className="text-xs text-neutral-500">1 000 nodes · 100 injections/day</div>
          </div>
          <button
            onClick={openBillingPortal}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-600"
          >
            Manage billing
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => upgrade('personal')}
            className="rounded-md border border-neutral-700 px-4 py-3 text-left text-sm hover:border-accent"
          >
            <div className="font-medium text-neutral-100">Upgrade to Personal</div>
            <div className="text-xs text-neutral-500">€9 / month</div>
          </button>
          <button
            onClick={() => upgrade('pro')}
            className="rounded-md bg-accent px-4 py-3 text-left text-sm font-semibold text-white hover:bg-accent-600"
          >
            <div>Upgrade to Pro</div>
            <div className="text-xs font-normal text-white/80">€19 / month</div>
          </button>
        </div>
      </section>

      <section className="mb-6 rounded-md border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-neutral-400">
          Notifications
        </h2>
        {!prefs ? (
          <ul className="space-y-3">
            {NOTIF_LABELS.map((n) => (
              <li
                key={n.key}
                className="flex items-start justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-950/50 p-3"
              >
                <div className="flex-1 space-y-1.5">
                  <Skeleton w="40%" h={12} rounded="sm" />
                  <Skeleton w="80%" h={9} rounded="sm" />
                </div>
                <Skeleton w={36} h={20} rounded="full" />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="space-y-3">
            {NOTIF_LABELS.map((n) => (
              <li
                key={n.key}
                className="flex items-start justify-between gap-4 rounded-md border border-neutral-800 bg-neutral-950/50 p-3"
              >
                <div>
                  <div className="text-sm text-neutral-200">{n.label}</div>
                  <div className="text-xs text-neutral-500">{n.hint}</div>
                </div>
                <button
                  role="switch"
                  aria-checked={!!prefs.notification_prefs[n.key]}
                  onClick={() => togglePref(n.key)}
                  className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
                    prefs.notification_prefs[n.key]
                      ? 'border-accent bg-accent'
                      : 'border-neutral-700 bg-neutral-800'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all ${
                      prefs.notification_prefs[n.key] ? 'left-4' : 'left-0.5'
                    }`}
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-6 rounded-md border border-neutral-800 bg-neutral-900 p-6">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-neutral-400">
          Privacy & data
        </h2>
        <p className="mb-3 text-sm text-neutral-300">
          Your data is yours. Export everything in one click, delete it any time.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={cleanupTitles}
            disabled={cleaning}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-600 disabled:opacity-50"
            title="Re-generate titles, summaries and embeddings for memories that look raw"
          >
            {cleaning ? 'Cleaning…' : '✨ Clean up memory titles'}
          </button>
          <button
            onClick={recluster}
            disabled={clustering}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-600 disabled:opacity-50"
            title="Group your memories into thematic clusters via k-means + LLM labels"
          >
            {clustering ? 'Clustering…' : '🎯 Re-cluster memories by theme'}
          </button>
          <button
            onClick={exportData}
            disabled={exporting}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-600 disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export my data (JSON)'}
          </button>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded border border-red-900 px-3 py-1.5 text-xs text-red-400 hover:bg-red-950"
            >
              Delete my account
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-400">Confirm? 72h grace then permanent.</span>
              <button
                onClick={deleteAccount}
                disabled={deleting}
                className="rounded border border-red-900 bg-red-950/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950 disabled:opacity-50"
              >
                {deleting ? 'Scheduling…' : 'Yes, delete'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
