import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Skeleton } from '@/components/Skeleton';

interface Channel {
  id: string;
  name: string;
  is_private: boolean;
  num_members: number | null;
  selected: boolean;
}

const API_BASE =
  (import.meta.env.VITE_API_URL as string) ??
  `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1`;

export default function SlackChannelsPage() {
  const navigate = useNavigate();
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [excludeDms, setExcludeDms] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/connectors-slack-channels`, {
          headers: { Authorization: `Bearer ${await getToken()}` },
        });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as { channels: Channel[] };
        if (!cancelled) setChannels(data.channels);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (id: string) => {
    setChannels((prev) =>
      prev?.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c)) ?? null,
    );
  };

  const save = async () => {
    if (!channels) return;
    setSaving(true);
    setError(null);
    try {
      const ids = channels.filter((c) => c.selected).map((c) => c.id);
      const res = await fetch(`${API_BASE}/connectors-slack-channels`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await getToken()}`,
        },
        body: JSON.stringify({ channels: ids, exclude_dms: excludeDms }),
      });
      if (!res.ok) throw new Error(await res.text());
      navigate('/connectors');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-semibold">Slack — choose channels</h1>
      <p className="mb-6 text-sm text-neutral-400">
        Mesh only reads messages from channels you explicitly check below.
      </p>

      {error && (
        <div className="mb-4 rounded-md border border-red-900 bg-red-950/30 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {!channels && !error && (
        <div className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-1 py-1.5">
              <Skeleton w={14} h={14} rounded="sm" />
              <Skeleton w={10} h={14} rounded="sm" />
              <Skeleton w="40%" h={12} rounded="sm" />
              <Skeleton w={60} h={10} rounded="sm" className="ml-auto" />
            </div>
          ))}
        </div>
      )}

      {channels && (
        <>
          <label className="mb-4 flex cursor-pointer items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-sm text-neutral-300">
            <input
              type="checkbox"
              checked={excludeDms}
              onChange={(e) => setExcludeDms(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span className="flex-1">Always exclude direct messages</span>
            <span className="text-xs text-neutral-500">recommended</span>
          </label>

          <ul className="mb-6 max-h-[55vh] divide-y divide-neutral-900 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/40">
            {channels.length === 0 && (
              <li className="p-4 text-center text-sm text-neutral-500">
                No channels available. Make sure you joined some channels in Slack first.
              </li>
            )}
            {channels.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={c.selected}
                  onChange={() => toggle(c.id)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                <span className="text-neutral-500">{c.is_private ? '🔒' : '#'}</span>
                <span className="flex-1 text-neutral-200">{c.name}</span>
                {c.num_members != null && (
                  <span className="text-xs text-neutral-500">{c.num_members} members</span>
                )}
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-between">
            <button
              onClick={() => navigate('/connectors')}
              className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:border-neutral-600"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save selection'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

async function getToken(): Promise<string> {
  const { supabase } = await import('@/lib/supabase');
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? '';
}
