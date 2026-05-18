/**
 * Cross-agent prompt injector.
 * Each adapter knows how to (a) read the current draft, (b) replace it,
 * (c) detect submission. We isolate per-agent quirks here.
 */

export interface AgentAdapter {
  hostname: string;
  /** CSS selector(s) for the prompt input element. */
  inputSelector: string;
  /** Whether the input is a textarea or contenteditable div. */
  inputKind: 'textarea' | 'contenteditable';
  /** Optional selector for a submit button to monitor. */
  submitSelector?: string;
}

export const AGENT_ADAPTERS: AgentAdapter[] = [
  {
    hostname: 'claude.ai',
    inputSelector: 'div[contenteditable="true"]',
    inputKind: 'contenteditable',
  },
  {
    hostname: 'chatgpt.com',
    inputSelector: '#prompt-textarea',
    inputKind: 'contenteditable',
  },
  {
    hostname: 'gemini.google.com',
    inputSelector: 'rich-textarea div[contenteditable="true"], rich-textarea textarea',
    inputKind: 'contenteditable',
  },
  {
    hostname: 'www.perplexity.ai',
    inputSelector: 'textarea[placeholder], textarea',
    inputKind: 'textarea',
  },
];

export function findAdapter(hostname: string): AgentAdapter | null {
  return AGENT_ADAPTERS.find((a) => a.hostname === hostname || hostname.endsWith(`.${a.hostname}`)) ?? null;
}

export function findInput(adapter: AgentAdapter): HTMLElement | null {
  // Prefer the deepest visible element (latest message composer).
  const all = document.querySelectorAll<HTMLElement>(adapter.inputSelector);
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i];
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

export function readDraft(adapter: AgentAdapter, el: HTMLElement): string {
  if (adapter.inputKind === 'textarea') {
    return (el as HTMLTextAreaElement).value ?? '';
  }
  return (el.textContent ?? '').trim();
}

/**
 * Replace draft with injected prompt. We try to preserve cursor at end.
 * For contenteditable, we use execCommand or InputEvent for proper React handling.
 */
export function writeDraft(adapter: AgentAdapter, el: HTMLElement, newText: string): void {
  if (adapter.inputKind === 'textarea') {
    const ta = el as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(ta, newText);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  // contenteditable path
  el.focus();
  // Clear existing content
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  selection?.removeAllRanges();
  selection?.addRange(range);

  // execCommand still works in MV3 and triggers React's onInput.
  document.execCommand('insertText', false, newText);
  // Fallback for browsers that ignored execCommand
  if ((el.textContent ?? '').trim() === '') {
    el.textContent = newText;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  }
}
