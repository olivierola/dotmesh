import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api-client';

type ProviderId = 'gmail' | 'gcal' | 'slack' | 'notion';

const PROVIDERS: Array<{
  id: ProviderId;
  label: string;
  description: string;
  available: boolean;
}> = [
  {
    id: 'gmail',
    label: 'Gmail',
    description: 'Capture sent emails — subject, recipient, body excerpt.',
    available: true,
  },
  {
    id: 'gcal',
    label: 'Google Calendar',
    description: 'Upcoming events + participants for the next 30 days.',
    available: true,
  },
  {
    id: 'slack',
    label: 'Slack',
    description: 'Messages in channels you opt in. DMs excluded by default.',
    available: true,
  },
  {
    id: 'notion',
    label: 'Notion',
    description: 'Recently edited pages, flattened to text.',
    available: true,
  },
];

export default function ConnectorsPage() {
  const { data: connectors } = useQuery({
    queryKey: ['connectors'],
    queryFn: () => api.listConnectors(),
  });

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-semibold">Agent Hub — Connectors</h1>
      <p className="mb-6 text-sm text-neutral-400">
        Connect your tools so Mesh can build your memory without you typing.
      </p>

      <ul className="flex flex-col gap-3">
        {PROVIDERS.map((p) => {
          const c = connectors?.find((x) => x.provider === p.id);
          return (
            <li
              key={p.id}
              className="flex items-start justify-between rounded-md border border-neutral-800 bg-neutral-900 p-4"
            >
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  {c?.status === 'active' ? (
                    <span className="text-emerald-400">●</span>
                  ) : (
                    <span className="text-neutral-600">○</span>
                  )}
                  <span>{p.label}</span>
                </div>
                <p className="mt-1 text-xs text-neutral-500">{p.description}</p>
                {c?.last_sync_at && (
                  <p className="mt-1 text-xs text-neutral-500">
                    Last sync {formatDistanceToNow(new Date(c.last_sync_at), { addSuffix: true })}
                  </p>
                )}
              </div>
              <div>
                {p.available && !c && (
                  <button
                    onClick={async () => {
                      try {
                        const { auth_url } = await api.startConnectorAuth(p.id);
                        window.location.href = auth_url;
                      } catch (e) {
                        alert(`Auth start failed: ${(e as Error).message}`);
                      }
                    }}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-600"
                  >
                    Connect
                  </button>
                )}
                {c && p.id === 'slack' && (
                  <Link
                    to="/connectors/slack/channels"
                    className="ml-2 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-600"
                  >
                    Channels
                  </Link>
                )}
                {!p.available && (
                  <span className="rounded-md border border-neutral-800 px-3 py-1.5 text-xs text-neutral-500">
                    Coming soon
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
