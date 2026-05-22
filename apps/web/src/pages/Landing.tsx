import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import DotGrid from '@/components/DotGrid';

const NAV_LINKS = [
  { id: 'problem', label: 'Problem' },
  { id: 'how', label: 'How it works' },
  { id: 'features', label: 'Features' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'pricing', label: 'Pricing' },
];

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="relative min-h-full overflow-x-hidden bg-neutral-950 text-neutral-100">
      <BackgroundGrid />
      <Navbar scrolled={scrolled} onLinkClick={scrollTo} />

      <main className="relative">
        <Hero />
        <ProblemSection />
        <HowItWorksSection />
        <FeaturesSection />
        <PrivacySection />
        <PricingSection />
        <FinalCTA />
        <Footer />
      </main>
    </div>
  );
}

// ============================================================
// Background — subtle grid + radial gradient
// ============================================================
function BackgroundGrid() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10">
      {/* Interactive dot-grid that lights up around the cursor and ripples
          on click. Sits behind every section. Wrapper has pointer-events
          none so it doesn't steal clicks from the content above. */}
      <div className="absolute inset-0">
        <DotGrid
          dotSize={2}
          gap={20}
          baseColor="#3a3a3a"
          activeColor="#f5b301"
          proximity={140}
          speedTrigger={130}
          shockRadius={260}
          shockStrength={6}
          returnDuration={1.6}
        />
      </div>
      {/* Soft radial glow at the top for visual depth */}
      <div
        className="absolute left-1/2 top-0 h-[600px] w-[1100px] -translate-x-1/2 opacity-20 blur-3xl"
        style={{
          background:
            'radial-gradient(circle at center, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 70%)',
        }}
      />
    </div>
  );
}

// ============================================================
// Floating navbar
// ============================================================
function Navbar({
  scrolled,
  onLinkClick,
}: {
  scrolled: boolean;
  onLinkClick: (id: string) => void;
}) {
  return (
    <header
      className={`fixed inset-x-0 top-4 z-50 mx-auto flex max-w-5xl items-center justify-between rounded-full border px-5 py-2.5 transition-all duration-300 ${
        scrolled
          ? 'border-neutral-800 bg-neutral-950/80 shadow-2xl shadow-black/30 backdrop-blur-xl'
          : 'border-neutral-800/40 bg-neutral-950/40 backdrop-blur-md'
      }`}
    >
      <Link to="/" className="flex items-center gap-1 text-base font-semibold tracking-tight">
        <span>mesh</span>
        <span className="text-accent">.</span>
      </Link>

      <nav className="hidden items-center gap-1 md:flex">
        {NAV_LINKS.map((l) => (
          <button
            key={l.id}
            onClick={() => onLinkClick(l.id)}
            className="rounded-full px-3 py-1.5 text-sm text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-neutral-200"
          >
            {l.label}
          </button>
        ))}
      </nav>

      <div className="flex items-center gap-2">
        <Link
          to="/login"
          className="hidden rounded-full px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-200 sm:inline-block"
        >
          Sign in
        </Link>
        <Link
          to="/dashboard"
          className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-white shadow-lg shadow-accent/20 hover:bg-accent-600"
        >
          Try the demo
        </Link>
      </div>
    </header>
  );
}

// ============================================================
// Hero
// ============================================================
function Hero() {
  return (
    <section className="relative px-6 pb-24 pt-40 md:pt-48">
      <div className="mx-auto max-w-4xl text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/50 px-3 py-1 text-xs text-neutral-400 backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          EU-first · RGPD by design · No ads, ever
        </div>

        <h1 className="bg-gradient-to-br from-white to-neutral-400 bg-clip-text text-5xl font-semibold leading-tight tracking-tight text-transparent md:text-7xl">
          The second brain that
          <br />
          builds itself.
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-lg text-neutral-400 md:text-xl">
          Mesh captures what matters passively, then makes every AI agent yours — Claude, ChatGPT,
          Gemini, Cursor. You stay in control.
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/dashboard"
            className="group flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white shadow-xl shadow-accent/30 transition-transform hover:scale-[1.02] hover:bg-accent-600"
          >
            Open dashboard
            <span className="transition-transform group-hover:translate-x-0.5">→</span>
          </Link>
          <a
            href="#how"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' });
            }}
            className="rounded-full border border-neutral-800 bg-neutral-900/50 px-6 py-3 text-sm text-neutral-200 backdrop-blur hover:border-neutral-700"
          >
            See how it works
          </a>
        </div>

        <p className="mt-6 text-xs text-neutral-500">
          Free forever · No credit card · Install in 30 seconds
        </p>
      </div>

      {/* Demo mock */}
      <div className="mx-auto mt-20 max-w-4xl">
        <DemoCard />
      </div>
    </section>
  );
}

function DemoCard() {
  return (
    <div className="relative rounded-2xl border border-neutral-800 bg-gradient-to-b from-neutral-900 to-neutral-950 p-1 shadow-2xl shadow-black/40">
      <div className="overflow-hidden rounded-xl border border-neutral-800/60 bg-neutral-950">
        {/* Window chrome */}
        <div className="flex items-center gap-1.5 border-b border-neutral-900 bg-neutral-950 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-800" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-800" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-800" />
          <div className="ml-4 flex-1 rounded bg-neutral-900 px-3 py-1 text-xs text-neutral-500">
            chatgpt.com / mesh active
          </div>
        </div>

        {/* Chat content */}
        <div className="space-y-4 p-6 text-sm">
          <div className="flex justify-end">
            <div className="max-w-md rounded-2xl rounded-br-md bg-neutral-800 px-4 py-2.5 text-neutral-100">
              Help me write to Sophie about the launch
            </div>
          </div>

          <div className="flex justify-start">
            <div className="max-w-md space-y-3">
              <div className="rounded-md border border-neutral-800 bg-neutral-900/60 p-3 text-xs">
                <div className="mb-1.5 flex items-center justify-between text-neutral-300">
                  <span className="font-medium">🧠 Mesh injected 3 memories</span>
                  <span className="text-neutral-500">via extension</span>
                </div>
                <ul className="space-y-1 text-neutral-300">
                  <li>· (today) Sophie wants less copy on onboarding</li>
                  <li>· (3d) Project Falcon deadline June 15</li>
                  <li>· (1w) Budget approved €45k, mobile-first</li>
                </ul>
              </div>
              <div className="rounded-2xl rounded-bl-md bg-neutral-900 px-4 py-2.5 text-neutral-200">
                Hi Sophie — quick note about the Falcon launch on June 15. I've trimmed the
                onboarding copy as discussed…
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Problem
// ============================================================
function ProblemSection() {
  const problems = [
    {
      title: 'Your agents have amnesia',
      body: 'ChatGPT forgets what Claude knew. Each agent rebuilds context from zero.',
    },
    {
      title: 'You type the same things 100×',
      body: '"My team is...", "My project is...", "The deadline is...". Every. Single. Time.',
    },
    {
      title: 'Your memory is captive',
      body: 'OpenAI owns your ChatGPT history. Anthropic owns your Claude conversations. Not you.',
    },
  ];

  return (
    <section id="problem" className="px-6 py-24">
      <div className="mx-auto max-w-5xl">
        <SectionHeader
          eyebrow="The problem"
          title="AI agents work in silos. You pay the tax."
          subtitle="Every conversation, every preference, every context — fragmented across tools that don't talk."
        />
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {problems.map((p, i) => (
            <div
              key={i}
              className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-6 backdrop-blur"
            >
              <div className="mb-3 text-2xl">{['🤖', '⌨️', '🔒'][i]}</div>
              <h3 className="mb-2 text-base font-medium text-neutral-100">{p.title}</h3>
              <p className="text-sm leading-relaxed text-neutral-400">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================
// How it works
// ============================================================
function HowItWorksSection() {
  const steps = [
    {
      n: '01',
      title: 'Install the extension',
      body: 'One-click install on Chrome or Firefox. No setup, no signup needed to try.',
    },
    {
      n: '02',
      title: 'Mesh listens passively',
      body: 'It captures what matters from your browsing — articles, AI sessions, emails. Sensitive sites are blocked by default.',
    },
    {
      n: '03',
      title: 'Your agents become personal',
      body: 'When you type in any AI agent, Mesh injects relevant context automatically. You approve or skip each time.',
    },
  ];

  return (
    <section id="how" className="px-6 py-24">
      <div className="mx-auto max-w-5xl">
        <SectionHeader
          eyebrow="How it works"
          title="Three steps. Zero friction."
          subtitle="No notes to write. No tagging to do. Mesh runs in the background and shows up when you need it."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-800 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.n} className="bg-neutral-950 p-8">
              <div className="mb-4 text-xs font-mono tracking-widest text-neutral-500">{s.n}</div>
              <h3 className="mb-3 text-lg font-medium">{s.title}</h3>
              <p className="text-sm leading-relaxed text-neutral-400">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Features grid
// ============================================================
function FeaturesSection() {
  const features = [
    {
      title: 'Cross-agent injection',
      body: 'Works with Claude, ChatGPT, Gemini, Perplexity. MCP-native for Claude Desktop and Cursor.',
      icon: '🔌',
    },
    {
      title: 'Passive capture',
      body: '6 signal types: reading, AI sessions, search, decisions, active work, deadlines.',
      icon: '📡',
    },
    {
      title: 'Personal knowledge graph',
      body: 'Cytoscape visualization. People, projects, topics — auto-linked by shared entities.',
      icon: '🕸️',
    },
    {
      title: 'Context Rules',
      body: 'Choose precisely what each agent can see. Tag-based, source-based, time-based filters.',
      icon: '🛡️',
    },
    {
      title: 'Connectors',
      body: 'Gmail, Calendar, Slack, Notion. Sent-only by default. Never overreaches.',
      icon: '🔗',
    },
    {
      title: 'Weekly insights',
      body: 'AI digest of your week: top themes, key people, decisions made, things to follow up.',
      icon: '✨',
    },
  ];

  return (
    <section id="features" className="px-6 py-24">
      <div className="mx-auto max-w-5xl">
        <SectionHeader
          eyebrow="Features"
          title="Built for power users."
          subtitle="Every feature is opt-in, observable, reversible."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          {features.map((f, i) => (
            <div
              key={i}
              className="group rounded-xl border border-neutral-800 bg-neutral-900/40 p-6 backdrop-blur transition-colors hover:border-neutral-700"
            >
              <div className="mb-3 text-2xl">{f.icon}</div>
              <h3 className="mb-2 text-base font-medium">{f.title}</h3>
              <p className="text-sm leading-relaxed text-neutral-400">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Privacy
// ============================================================
function PrivacySection() {
  const guarantees = [
    'Hosted in EU (Frankfurt). Your data never leaves.',
    'RGPD by design: delete everything in 1 click, 72h hard wipe.',
    'No ads. No data resale. Ever. It would break our entire model.',
    'Sensitive sites blocked by default: banking, healthcare, gov, private chats.',
    'Audit log is immutable. You can prove what we touched.',
    'Open source MCP server. Self-host the agent integration if you want.',
  ];

  return (
    <section
      id="privacy"
      className="relative overflow-hidden border-y border-neutral-800/60 bg-neutral-900/30 px-6 py-24"
    >
      <div className="mx-auto max-w-5xl">
        <SectionHeader
          eyebrow="Privacy"
          title="Built differently because of where we live."
          subtitle="Mesh exists because the US-built memory tools didn't pass our own privacy bar. EU-native isn't marketing — it's the architecture."
        />
        <div className="mt-12 grid gap-3 md:grid-cols-2">
          {guarantees.map((g, i) => (
            <div
              key={i}
              className="flex items-start gap-3 rounded-lg border border-neutral-800 bg-neutral-950/50 p-4"
            >
              <span className="mt-0.5 text-emerald-400">✓</span>
              <span className="text-sm text-neutral-300">{g}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Pricing
// ============================================================
function PricingSection() {
  const tiers = [
    {
      name: 'Free',
      price: '€0',
      period: 'forever',
      features: [
        '1 000 memories',
        '1 connector',
        '100 injections / day',
        'Extension only',
        'EU-hosted',
      ],
      cta: 'Start free',
      featured: false,
    },
    {
      name: 'Personal',
      price: '€9',
      period: '/ month',
      features: [
        'Unlimited memories',
        '3 connectors',
        '1 000 injections / day',
        'Weekly AI insights',
        'Email support',
      ],
      cta: 'Go Personal',
      featured: true,
    },
    {
      name: 'Pro',
      price: '€19',
      period: '/ month',
      features: [
        'Everything in Personal',
        'Unlimited connectors',
        'Unlimited injections',
        'MCP server access',
        'Priority support',
      ],
      cta: 'Get Pro',
      featured: false,
    },
  ];

  return (
    <section id="pricing" className="px-6 py-24">
      <div className="mx-auto max-w-5xl">
        <SectionHeader
          eyebrow="Pricing"
          title="Generous free tier. Fair paid tiers."
          subtitle="No annual lock-in tricks. Cancel any time, your data is yours to export."
        />
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {tiers.map((t) => (
            <div
              key={t.name}
              className={`relative rounded-2xl border p-6 transition-all ${
                t.featured
                  ? 'scale-[1.02] border-accent/60 bg-gradient-to-b from-accent/10 to-neutral-900/40 shadow-xl shadow-accent/10'
                  : 'border-neutral-800 bg-neutral-900/40'
              }`}
            >
              {t.featured && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-accent px-3 py-0.5 text-xs font-semibold text-white">
                  Most popular
                </div>
              )}
              <div className="mb-6">
                <div className="mb-2 text-sm font-medium text-neutral-400">{t.name}</div>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-semibold">{t.price}</span>
                  <span className="text-sm text-neutral-500">{t.period}</span>
                </div>
              </div>
              <ul className="mb-8 space-y-2.5">
                {t.features.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-neutral-300">
                    <span className="mt-0.5 text-neutral-500">·</span>
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                to="/dashboard"
                className={`block w-full rounded-md px-4 py-2.5 text-center text-sm font-medium transition-colors ${
                  t.featured
                    ? 'bg-accent font-semibold text-white hover:bg-accent-600'
                    : 'border border-neutral-700 text-neutral-200 hover:border-neutral-600'
                }`}
              >
                {t.cta}
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Final CTA
// ============================================================
function FinalCTA() {
  return (
    <section className="px-6 py-24">
      <div className="mx-auto max-w-3xl rounded-3xl border border-neutral-800 bg-gradient-to-b from-neutral-900 to-neutral-950 p-12 text-center">
        <h2 className="bg-gradient-to-br from-white to-neutral-400 bg-clip-text text-3xl font-semibold tracking-tight text-transparent md:text-4xl">
          Stop explaining yourself to every AI.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-neutral-400">
          Install Mesh in 30 seconds. Your agents will know you by tomorrow.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            to="/dashboard"
            className="rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white shadow-xl shadow-accent/30 hover:bg-accent-600"
          >
            Open the demo →
          </Link>
          <a
            href="https://github.com/mesh"
            className="rounded-full border border-neutral-800 px-6 py-3 text-sm text-neutral-300 hover:border-neutral-700"
          >
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Footer
// ============================================================
function Footer() {
  return (
    <footer className="border-t border-neutral-900 px-6 py-10">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 text-xs text-neutral-500 md:flex-row">
        <div className="flex items-center gap-1">
          <span>mesh</span>
          <span className="text-accent">.</span>
          <span className="ml-2">© {new Date().getFullYear()}</span>
        </div>
        <div className="flex items-center gap-6">
          <a href="#" className="hover:text-neutral-300">
            Privacy
          </a>
          <a href="#" className="hover:text-neutral-300">
            Terms
          </a>
          <a href="#" className="hover:text-neutral-300">
            Docs
          </a>
          <a href="#" className="hover:text-neutral-300">
            Contact
          </a>
        </div>
      </div>
    </footer>
  );
}

// ============================================================
// Shared section header
// ============================================================
function SectionHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <div className="mb-3 text-xs font-medium uppercase tracking-widest text-neutral-500">
        {eyebrow}
      </div>
      <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">{title}</h2>
      <p className="mt-3 text-base text-neutral-400">{subtitle}</p>
    </div>
  );
}
