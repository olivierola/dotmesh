import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { api } from '@/lib/api-client';
import { Skeleton } from '@/components/Skeleton';

interface Insight {
  id: string;
  week_start: string;
  themes: Array<{ label: string; count: number }>;
  people: Array<{ label: string; count: number }>;
  decisions: Array<{ text: string; node_id: string }>;
  expiring: Array<{ node_id: string; ttl_at: string }>;
  narrative: string | null;
  node_count: number;
  created_at: string;
}

// Mock insight for dev mode
const MOCK_INSIGHTS: Insight[] = [
  {
    id: 'i1',
    week_start: new Date(Date.now() - 7 * 86400_000).toISOString().split('T')[0]!,
    themes: [
      { label: 'Project Falcon', count: 12 },
      { label: 'agent memory', count: 6 },
      { label: 'onboarding copy', count: 4 },
    ],
    people: [
      { label: 'Sophie', count: 8 },
      { label: 'Alex', count: 3 },
    ],
    decisions: [
      { text: 'Sophie requested fewer words on onboarding for Project Falcon.', node_id: 'n1' },
    ],
    expiring: [],
    narrative:
      'We noticed Project Falcon dominated your week, with Sophie at the center of most conversations. The onboarding copy iteration seems to be wrapping up, and the team is converging on a shorter, mobile-first format. One thing worth following up on: the deadline of June 15 — make sure the design review is locked in before then.',
    node_count: 23,
    created_at: new Date().toISOString(),
  },
];

export default function InsightsPage() {
  const { data: insights, isLoading } = useQuery({
    queryKey: ['insights'],
    queryFn: async () => {
      if (api.isMock) return MOCK_INSIGHTS;
      // Real backend: read from the weekly_insights table via Supabase client.
      const { supabase } = await import('@/lib/supabase');
      const { data, error } = await supabase
        .from('weekly_insights')
        .select('*')
        .order('week_start', { ascending: false })
        .limit(8);
      if (error) throw error;
      return (data ?? []) as Insight[];
    },
  });

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 className="mb-1 text-2xl font-semibold">Weekly Insights</h1>
      <p className="mb-6 text-sm text-neutral-400">
        Every Monday morning, Mesh distills your week into themes, people, and decisions.
      </p>

      {isLoading && (
        <div className="space-y-6">
          {Array.from({ length: 2 }).map((_, i) => (
            <article key={i} className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6">
              <Skeleton w={180} h={18} rounded="md" />
              <Skeleton w={120} h={10} rounded="sm" className="mt-2" />
              <div className="mt-4 space-y-2">
                <Skeleton w="100%" h={10} rounded="sm" />
                <Skeleton w="95%" h={10} rounded="sm" />
                <Skeleton w="80%" h={10} rounded="sm" />
              </div>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <Skeleton w="100%" h={80} rounded="md" />
                <Skeleton w="100%" h={80} rounded="md" />
              </div>
            </article>
          ))}
        </div>
      )}

      {insights?.length === 0 && (
        <div className="rounded-md border border-dashed border-neutral-800 p-8 text-center text-sm text-neutral-500">
          No insights yet. Your first digest will appear next Monday.
        </div>
      )}

      <div className="flex flex-col gap-6">
        {insights?.map((ins) => <InsightCard key={ins.id} ins={ins} />)}
      </div>
    </div>
  );
}

function InsightCard({ ins }: { ins: Insight }) {
  return (
    <article className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-6">
      <header className="mb-4 flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-medium">Week of {ins.week_start}</h2>
          <p className="text-xs text-neutral-500">
            {ins.node_count} memories ·{' '}
            {formatDistanceToNow(new Date(ins.created_at), { addSuffix: true })}
          </p>
        </div>
      </header>

      {ins.narrative && (
        <p className="mb-6 whitespace-pre-line text-sm leading-relaxed text-neutral-200">
          {ins.narrative}
        </p>
      )}

      <div className="grid gap-4 text-sm md:grid-cols-2">
        <Block title="Top themes">
          {ins.themes.length > 0 ? (
            <ul className="space-y-1">
              {ins.themes.map((t) => (
                <li key={t.label} className="flex justify-between text-neutral-300">
                  <span>{t.label}</span>
                  <span className="text-neutral-500">{t.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-neutral-500">No dominant themes.</p>
          )}
        </Block>

        <Block title="Key people">
          {ins.people.length > 0 ? (
            <ul className="space-y-1">
              {ins.people.map((p) => (
                <li key={p.label} className="flex justify-between text-neutral-300">
                  <span>{p.label}</span>
                  <span className="text-neutral-500">{p.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-neutral-500">No people in focus.</p>
          )}
        </Block>

        {ins.decisions.length > 0 && (
          <Block title="Decisions made">
            <ul className="space-y-2">
              {ins.decisions.map((d, i) => (
                <li key={i} className="text-neutral-300">
                  · {d.text}
                </li>
              ))}
            </ul>
          </Block>
        )}

        {ins.expiring.length > 0 && (
          <Block title="Expiring soon">
            <p className="text-neutral-400">
              {ins.expiring.length} memories will auto-delete this week.
            </p>
          </Block>
        )}
      </div>
    </article>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 p-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-widest text-neutral-500">
        {title}
      </h3>
      {children}
    </div>
  );
}
