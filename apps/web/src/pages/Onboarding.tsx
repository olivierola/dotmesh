import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api-client';

interface Step {
  id: string;
  title: string;
  subtitle: string;
}

const STEPS: Step[] = [
  { id: 'welcome', title: 'Welcome to Mesh', subtitle: 'The second brain that builds itself.' },
  { id: 'extension', title: 'Install the extension', subtitle: 'Chrome or Firefox — 1 click.' },
  { id: 'capture', title: 'See your first capture', subtitle: 'Mesh just learned its first thing about you.' },
  { id: 'connect', title: 'Link your AI agents', subtitle: 'Optional but recommended.' },
  { id: 'connectors', title: 'Connect your tools (optional)', subtitle: 'Gmail, Calendar, Slack — skip if you prefer.' },
];

export default function OnboardingPage() {
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex]!;

  const next = async () => {
    if (stepIndex === STEPS.length - 1) {
      try {
        await api.completeOnboarding();
      } catch {
        // non-fatal
      }
      navigate('/dashboard');
    } else {
      setStepIndex(stepIndex + 1);
    }
  };
  const skip = async () => {
    try {
      await api.completeOnboarding();
    } catch {
      /* ignore */
    }
    navigate('/dashboard');
  };

  return (
    <div className="grid min-h-full place-items-center bg-neutral-950 px-6 py-12">
      <div className="w-full max-w-xl">
        {/* Progress dots */}
        <div className="mb-10 flex items-center justify-center gap-2">
          {STEPS.map((s, i) => (
            <div
              key={s.id}
              className={`h-1.5 rounded-full transition-all ${
                i === stepIndex
                  ? 'w-8 bg-accent'
                  : i < stepIndex
                    ? 'w-1.5 bg-accent/60'
                    : 'w-1.5 bg-neutral-800'
              }`}
            />
          ))}
        </div>

        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-10 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{step.title}</h1>
          <p className="mt-2 text-sm text-neutral-400">{step.subtitle}</p>

          <div className="my-8">
            {step.id === 'welcome' && <WelcomeStep />}
            {step.id === 'extension' && <ExtensionStep />}
            {step.id === 'capture' && <CaptureStep />}
            {step.id === 'connect' && <ConnectStep />}
            {step.id === 'connectors' && <ConnectorsStep />}
          </div>

          <div className="flex items-center justify-between">
            <button
              onClick={skip}
              className="text-xs text-neutral-500 hover:text-neutral-300"
            >
              Skip onboarding
            </button>
            <button
              onClick={next}
              className="rounded-md bg-accent px-5 py-2 text-sm font-semibold text-white hover:bg-accent-600"
            >
              {stepIndex === STEPS.length - 1 ? 'Open dashboard' : 'Continue →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WelcomeStep() {
  return (
    <div className="space-y-3 text-sm text-neutral-300">
      <p>
        Mesh listens passively to what you read and do, then makes every AI agent personal — Claude,
        ChatGPT, Gemini, Cursor.
      </p>
      <p className="text-xs text-neutral-500">
        EU-hosted. Privacy by design. Free forever for hobby use.
      </p>
    </div>
  );
}

function ExtensionStep() {
  return (
    <div className="space-y-4 text-sm">
      <a
        href="https://chrome.google.com/webstore/detail/coming-soon"
        target="_blank"
        rel="noreferrer"
        className="block rounded-lg border border-neutral-700 bg-neutral-950 p-4 text-left hover:border-neutral-600"
      >
        <div className="font-medium text-neutral-100">Add to Chrome</div>
        <div className="text-xs text-neutral-500">Chrome Web Store · ~50 KB · 1 click</div>
      </a>
      <a
        href="https://addons.mozilla.org/firefox/addon/coming-soon"
        target="_blank"
        rel="noreferrer"
        className="block rounded-lg border border-neutral-700 bg-neutral-950 p-4 text-left hover:border-neutral-600"
      >
        <div className="font-medium text-neutral-100">Add to Firefox</div>
        <div className="text-xs text-neutral-500">Firefox Add-ons</div>
      </a>
    </div>
  );
}

function CaptureStep() {
  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-4 text-left">
        <div className="flex items-center gap-2 text-emerald-400">
          <span>✓</span>
          <span className="font-medium">First memory captured</span>
        </div>
        <p className="mt-1 text-xs text-neutral-400">
          You just read this onboarding flow — Mesh saved it as your first node.
        </p>
      </div>
      <p className="text-xs text-neutral-500">
        From now on, anything you read for more than 45 seconds will be captured (unless on a
        blocked domain).
      </p>
    </div>
  );
}

function ConnectStep() {
  const agents = [
    { name: 'Claude.ai', supported: true },
    { name: 'ChatGPT', supported: true },
    { name: 'Gemini', supported: true },
    { name: 'Perplexity', supported: true },
    { name: 'Claude Desktop', supported: true, via: 'MCP' },
    { name: 'Cursor', supported: true, via: 'MCP' },
  ];
  return (
    <div className="space-y-2 text-sm">
      <p className="text-neutral-300">
        Mesh works with these agents out of the box. No setup needed.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {agents.map((a) => (
          <div
            key={a.name}
            className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs"
          >
            <span className="text-emerald-400">✓</span>
            <span className="text-neutral-200">{a.name}</span>
            {a.via && <span className="ml-auto text-neutral-500">{a.via}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectorsStep() {
  const conns = ['Gmail', 'Google Calendar', 'Slack', 'Notion'];
  return (
    <div className="space-y-3 text-sm">
      <p className="text-neutral-300">
        Connect your tools so Mesh can build your memory faster. You can do this later.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {conns.map((c) => (
          <button
            key={c}
            disabled
            className="rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-400 disabled:cursor-not-allowed"
          >
            Connect {c}
          </button>
        ))}
      </div>
      <p className="text-xs text-neutral-500">Available once your account is fully set up.</p>
    </div>
  );
}
