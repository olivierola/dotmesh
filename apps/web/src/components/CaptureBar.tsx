import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Capture bar with slash-command palette.
 *
 * Typing "/" at the start of the input opens a fuzzy command picker.
 * Each command can transform the typed text into a structured Capture
 * (tags, ttl, pinned, source override) before submission.
 *
 * Built-in commands:
 *   /todo  <text>        → tag:'todo' + pinned
 *   /note  <text>        → tag:'note'
 *   /idea  <text>        → tag:'idea'
 *   /pin   <text>        → pinned
 *   /temp  <text>        → ttl:24h
 *   /week  <text>        → ttl:7d
 *   /tag   <name> <text> → adds a custom tag
 */

export interface CapturePayload {
  content: string;
  tags?: string[];
  ttl?: string;
  pinned?: boolean;
}

interface Command {
  trigger: string;
  label: string;
  hint: string;
  /** Transform raw text (without the trigger) into a payload. */
  build: (text: string) => CapturePayload;
}

const COMMANDS: Command[] = [
  {
    trigger: '/todo',
    label: 'To-do',
    hint: 'Save as pinned task',
    build: (text) => ({ content: text, tags: ['todo'], pinned: true }),
  },
  {
    trigger: '/note',
    label: 'Note',
    hint: 'Quick note',
    build: (text) => ({ content: text, tags: ['note'] }),
  },
  {
    trigger: '/idea',
    label: 'Idea',
    hint: 'Tag as idea',
    build: (text) => ({ content: text, tags: ['idea'] }),
  },
  {
    trigger: '/pin',
    label: 'Pinned memory',
    hint: 'Save and pin',
    build: (text) => ({ content: text, pinned: true }),
  },
  {
    trigger: '/temp',
    label: 'Temporary (24h)',
    hint: 'Auto-delete after a day',
    build: (text) => ({ content: text, ttl: '24h' }),
  },
  {
    trigger: '/week',
    label: 'Temporary (7d)',
    hint: 'Auto-delete after a week',
    build: (text) => ({ content: text, ttl: '7d' }),
  },
  {
    trigger: '/tag',
    label: 'Tag <name> <text>',
    hint: 'Add a custom tag',
    build: (text) => {
      const m = text.match(/^(\S+)\s+(.+)$/);
      return m && m[1] && m[2]
        ? { content: m[2], tags: [m[1].toLowerCase()] }
        : { content: text };
    },
  },
];

interface Props {
  onSubmit: (payload: CapturePayload) => void | Promise<void>;
  pending?: boolean;
}

export default function CaptureBar({ onSubmit, pending }: Props) {
  const [text, setText] = useState('');
  const [picker, setPicker] = useState<{ open: boolean; index: number }>({ open: false, index: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const slashQuery = text.startsWith('/') ? text.split(/\s/)[0]?.toLowerCase() ?? '' : '';
  const filtered = useMemo(() => {
    if (!slashQuery) return [];
    return COMMANDS.filter((c) => c.trigger.startsWith(slashQuery));
  }, [slashQuery]);

  useEffect(() => {
    setPicker({ open: filtered.length > 0 && text.startsWith('/'), index: 0 });
  }, [text, filtered.length]);

  const submit = async () => {
    const v = text.trim();
    if (!v) return;
    const cmd = COMMANDS.find((c) => v.toLowerCase().startsWith(c.trigger + ' '));
    let payload: CapturePayload;
    if (cmd) {
      const arg = v.slice(cmd.trigger.length).trim();
      payload = cmd.build(arg);
    } else if (v.startsWith('/') && !v.includes(' ')) {
      // Trigger alone: do nothing
      return;
    } else {
      payload = { content: v };
    }
    if (!payload.content.trim()) return;
    await onSubmit(payload);
    setText('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (picker.open && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPicker((p) => ({ ...p, index: (p.index + 1) % filtered.length }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPicker((p) => ({ ...p, index: (p.index - 1 + filtered.length) % filtered.length }));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !text.includes(' '))) {
        e.preventDefault();
        const chosen = filtered[picker.index];
        if (chosen) setText(chosen.trigger + ' ');
        return;
      }
      if (e.key === 'Escape') {
        setPicker({ open: false, index: 0 });
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="relative mb-6">
      <div className="flex gap-2">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Add a memory… type / for commands"
          className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
        <button
          onClick={submit}
          disabled={pending || !text.trim()}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-600 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Capture'}
        </button>
      </div>

      {picker.open && filtered.length > 0 && (
        <div className="absolute left-0 right-12 top-full z-20 mt-1 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 shadow-2xl">
          <ul className="max-h-64 overflow-y-auto">
            {filtered.map((c, i) => (
              <li key={c.trigger}>
                <button
                  type="button"
                  onClick={() => setText(c.trigger + ' ')}
                  onMouseEnter={() => setPicker({ open: true, index: i })}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                    i === picker.index ? 'bg-neutral-900' : 'hover:bg-neutral-900/60'
                  }`}
                >
                  <span>
                    <code className="mr-2 font-mono text-xs text-accent">{c.trigger}</code>
                    <span className="text-neutral-200">{c.label}</span>
                  </span>
                  <span className="text-xs text-neutral-500">{c.hint}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-neutral-900 px-3 py-1.5 text-[10px] text-neutral-600">
            ↑↓ navigate · Tab to autocomplete · Enter to submit
          </div>
        </div>
      )}
    </div>
  );
}
