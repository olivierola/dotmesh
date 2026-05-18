import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '@/lib/api-client';
import type { MockNode, RecentInjection } from '@/lib/mock';
import { Skeleton, SkeletonKpi, SkeletonRow } from '@/components/Skeleton';

const ACCENT = '#f5b301';
const ACCENT_SOFT = 'rgba(245,179,1,0.18)';
const SOURCE_COLORS: Record<string, string> = {
  extension: '#60a5fa',
  manual: '#a78bfa',
  mcp: '#34d399',
  'connector:gmail': '#f87171',
  'connector:slack': '#fbbf24',
  'connector:gcal': '#22d3ee',
  'connector:notion': '#e5e5e5',
};
function colorFor(source: string): string {
  return SOURCE_COLORS[source] ?? '#737373';
}

export default function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.loadDashboard(),
  });

  if (isLoading || !data) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Your memory at a glance — what was captured, what your agents pulled.
        </p>
      </header>

      {/* KPI cards */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          label="Memories"
          value={data.totals.nodes.toLocaleString()}
          hint={`+${data.totals.captures_today} today`}
        />
        <Kpi
          label="Injections this week"
          value={data.totals.injections_week.toLocaleString()}
          hint={`${data.totals.injections_today} today`}
          accent
        />
        <Kpi
          label="Captures this week"
          value={data.totals.captures_week.toLocaleString()}
          hint={`avg score ${(data.totals.avg_score * 100).toFixed(0)}%`}
        />
        <Kpi
          label="Edges (graph)"
          value={data.totals.edges.toLocaleString()}
          hint="auto-linked"
        />
      </section>

      {/* Activity chart */}
      <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
        <div className="mb-4 flex items-baseline justify-between">
          <div>
            <h2 className="text-sm font-medium text-neutral-200">Activity — last 30 days</h2>
            <p className="text-xs text-neutral-500">Captures, injections, and pulls per day.</p>
          </div>
          <Legend
            items={[
              { color: ACCENT, label: 'Captures' },
              { color: '#60a5fa', label: 'Injections' },
              { color: '#a78bfa', label: 'Pulls' },
            ]}
          />
        </div>
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.daily} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
              <defs>
                <linearGradient id="g-captures" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={ACCENT} stopOpacity={0.45} />
                  <stop offset="95%" stopColor={ACCENT} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="g-injections" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#60a5fa" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#60a5fa" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="g-pulls" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#a78bfa" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
              <XAxis
                dataKey="date"
                stroke="#525252"
                fontSize={10}
                tickFormatter={(d: string) => d.slice(5)}
                interval={4}
              />
              <YAxis stroke="#525252" fontSize={10} width={32} />
              <Tooltip
                contentStyle={{
                  background: '#0a0a0a',
                  border: '1px solid #262626',
                  borderRadius: 6,
                  fontSize: 12,
                }}
                labelStyle={{ color: '#a3a3a3' }}
              />
              <Area
                type="monotone"
                dataKey="captures"
                stroke={ACCENT}
                strokeWidth={1.5}
                fill="url(#g-captures)"
              />
              <Area
                type="monotone"
                dataKey="injections"
                stroke="#60a5fa"
                strokeWidth={1.5}
                fill="url(#g-injections)"
              />
              <Area
                type="monotone"
                dataKey="pulls"
                stroke="#a78bfa"
                strokeWidth={1.5}
                fill="url(#g-pulls)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* By source pie */}
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
          <h2 className="mb-1 text-sm font-medium text-neutral-200">Captures by source</h2>
          <p className="mb-4 text-xs text-neutral-500">Where memories come from.</p>
          <div className="flex items-center gap-4">
            <div style={{ width: 160, height: 160 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.by_source}
                    dataKey="count"
                    nameKey="source"
                    innerRadius={48}
                    outerRadius={72}
                    paddingAngle={2}
                  >
                    {data.by_source.map((s) => (
                      <Cell
                        key={s.source}
                        fill={colorFor(s.source)}
                        stroke="#0a0a0a"
                        strokeWidth={2}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: '#0a0a0a',
                      border: '1px solid #262626',
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="flex-1 space-y-1.5 text-xs">
              {data.by_source.map((s) => (
                <li key={s.source} className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-neutral-300">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: colorFor(s.source) }}
                    />
                    {s.source}
                  </span>
                  <span className="text-neutral-500">{s.count}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* By agent bar */}
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
          <h2 className="mb-1 text-sm font-medium text-neutral-200">Injections by agent</h2>
          <p className="mb-4 text-xs text-neutral-500">
            How many injections per agent · accept rate.
          </p>
          <div style={{ height: 180 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.by_agent}
                layout="vertical"
                margin={{ top: 4, right: 16, bottom: 0, left: 30 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#262626" horizontal={false} />
                <XAxis type="number" stroke="#525252" fontSize={10} />
                <YAxis
                  type="category"
                  dataKey="agent"
                  stroke="#525252"
                  fontSize={10}
                  width={110}
                />
                <Tooltip
                  contentStyle={{
                    background: '#0a0a0a',
                    border: '1px solid #262626',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  cursor={{ fill: ACCENT_SOFT }}
                />
                <Bar dataKey="injections" fill={ACCENT} radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <ul className="mt-2 space-y-1 text-xs">
            {data.by_agent.map((a) => (
              <li
                key={a.agent}
                className="flex items-center justify-between text-neutral-400"
              >
                <span>{a.agent}</span>
                <span
                  className={
                    a.accept_rate >= 0.7
                      ? 'text-emerald-400'
                      : a.accept_rate >= 0.4
                        ? 'text-amber-400'
                        : 'text-red-400'
                  }
                >
                  {(a.accept_rate * 100).toFixed(0)}% accept
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* Recent activity */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium text-neutral-200">Recent memories</h2>
            <Link to="/timeline" className="text-xs text-accent hover:underline">
              View all →
            </Link>
          </div>
          <ul className="space-y-2">
            {data.recent_nodes.map((n) => (
              <RecentNodeRow key={n.id} n={n} />
            ))}
            {data.recent_nodes.length === 0 && (
              <li className="text-xs text-neutral-500">No memories yet.</li>
            )}
          </ul>
        </section>

        <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium text-neutral-200">Recent injections</h2>
            <Link to="/rules" className="text-xs text-accent hover:underline">
              Manage rules →
            </Link>
          </div>
          <ul className="space-y-2">
            {data.recent_injections.map((i) => (
              <RecentInjectionRow key={i.id} i={i} />
            ))}
            {data.recent_injections.length === 0 && (
              <li className="text-xs text-neutral-500">No injections yet.</li>
            )}
          </ul>
        </section>
      </div>

      {/* Quick actions */}
      <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
        <h2 className="mb-3 text-sm font-medium text-neutral-200">Quick actions</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <QuickAction to="/timeline" icon="🗂" label="Browse timeline" />
          <QuickAction to="/search" icon="🔍" label="Search memories" />
          <QuickAction to="/connectors" icon="🔗" label="Add a connector" />
          <QuickAction to="/insights" icon="✨" label="Read this week's digest" />
        </div>
      </section>
    </div>
  );
}

// ---------------- helpers ----------------

function Kpi({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        accent
          ? 'border-accent/40 bg-gradient-to-b from-accent/10 to-neutral-900/40'
          : 'border-neutral-800 bg-neutral-900/40'
      }`}
    >
      <div className="text-xs uppercase tracking-widest text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-neutral-100">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-neutral-500">{hint}</div>}
    </div>
  );
}

function Legend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <div className="flex items-center gap-4 text-xs text-neutral-500">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: i.color }} />
          {i.label}
        </div>
      ))}
    </div>
  );
}

function RecentNodeRow({ n }: { n: MockNode }) {
  return (
    <li className="rounded-md border border-neutral-800 bg-neutral-950/50 p-3 text-sm">
      <div className="mb-1 flex items-center justify-between text-xs text-neutral-500">
        <span className="flex items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: colorFor(n.source) }}
          />
          {n.source}
        </span>
        <span>{formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}</span>
      </div>
      <p className="text-neutral-300">{(n.summary ?? n.content).slice(0, 140)}</p>
    </li>
  );
}

function RecentInjectionRow({ i }: { i: RecentInjection }) {
  return (
    <li className="rounded-md border border-neutral-800 bg-neutral-950/50 p-3 text-sm">
      <div className="mb-1 flex items-center justify-between text-xs text-neutral-500">
        <span>{i.target_agent}</span>
        <span>{formatDistanceToNow(new Date(i.created_at), { addSuffix: true })}</span>
      </div>
      <p className="text-neutral-300">{i.query_excerpt}</p>
      <div className="mt-1.5 flex items-center justify-between text-[11px]">
        <span className="text-neutral-500">{i.nodes_used} memories used</span>
        <span className={i.accepted ? 'text-emerald-400' : 'text-neutral-500'}>
          {i.accepted ? '✓ accepted' : 'skipped'}
        </span>
      </div>
    </li>
  );
}

function QuickAction({ to, icon, label }: { to: string; icon: string; label: string }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 rounded-md border border-neutral-800 bg-neutral-950/50 p-3 text-sm text-neutral-200 transition-colors hover:border-neutral-700"
    >
      <span className="text-lg">{icon}</span>
      {label}
    </Link>
  );
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header>
        <Skeleton w={140} h={28} rounded="md" />
        <Skeleton w="50%" h={12} rounded="sm" className="mt-3" />
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonKpi key={i} />
        ))}
      </section>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
        <Skeleton w="40%" h={14} rounded="sm" />
        <Skeleton w="60%" h={10} rounded="sm" className="mt-2" />
        <Skeleton w="100%" h={240} rounded="md" className="mt-4" />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
          <Skeleton w="50%" h={14} rounded="sm" />
          <div className="mt-5 flex items-center gap-4">
            <Skeleton w={160} h={160} rounded="full" />
            <div className="flex-1 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between">
                  <Skeleton w="60%" h={10} rounded="sm" />
                  <Skeleton w={20} h={10} rounded="sm" />
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
          <Skeleton w="50%" h={14} rounded="sm" />
          <Skeleton w="100%" h={180} rounded="md" className="mt-4" />
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
          <Skeleton w="40%" h={14} rounded="sm" className="mb-4" />
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        </section>
        <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
          <Skeleton w="40%" h={14} rounded="sm" className="mb-4" />
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
