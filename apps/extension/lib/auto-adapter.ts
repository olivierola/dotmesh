/**
 * Heuristic chatbot adapter.
 *
 * For sites that don't have a dedicated AGENT_ADAPTERS entry (custom React
 * chatbots, embedded widgets like Intercom/Crisp/Drift, niche AI tools), we
 * try to discover the prompt input + send button by inspecting the live DOM.
 *
 * The detection is conservative: we only return an adapter when both an
 * input AND a plausible submit button are present. Otherwise the regular
 * passive-capture path takes over and the page is left untouched.
 *
 * Re-runs on a MutationObserver because most widgets mount asynchronously
 * after the page becomes interactive.
 */

import type { AgentAdapter, WriteStrategy } from './injector';

/** Words that mark an input as "send a chat message" intent. */
const PROMPT_HINTS = [
  'ask',
  'message',
  'send',
  'prompt',
  'chat',
  'tape',
  'écris',
  'pose ta question',
  'parler',
  'how can i help',
  'que puis-je',
  'votre question',
];

/** Words that mark a button as a chatbot submit. */
const SUBMIT_HINTS = [
  'send',
  'envoyer',
  'submit',
  'ask',
  'go',
  'enter',
  'demander',
  'envoie',
];

function looksLikePromptInput(el: HTMLElement): { ok: boolean; strategy: WriteStrategy } | null {
  if (!isVisible(el)) return null;

  const tag = el.tagName;
  if (tag === 'TEXTAREA') {
    const ta = el as HTMLTextAreaElement;
    if (ta.disabled || ta.readOnly) return null;
    const haystack = [
      ta.placeholder,
      ta.getAttribute('aria-label'),
      ta.getAttribute('name'),
      ta.getAttribute('data-testid'),
      (ta.closest('form')?.getAttribute('aria-label') ?? ''),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!PROMPT_HINTS.some((h) => haystack.includes(h))) return null;
    return { ok: true, strategy: 'textarea' };
  }
  if (el.getAttribute('contenteditable') === 'true') {
    if (el.getAttribute('aria-disabled') === 'true') return null;
    const haystack = [
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('data-placeholder'),
      el.getAttribute('role'),
      el.getAttribute('data-testid'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    // Contenteditable inputs without any chat-y signal are very common
    // (rich-text editors in CMS, comment boxes). Require a hint to avoid
    // hijacking the wrong field.
    if (!PROMPT_HINTS.some((h) => haystack.includes(h))) return null;
    // Generic execCommand path — works for most widget contenteditable.
    return { ok: true, strategy: 'execCommand' };
  }
  return null;
}

function looksLikeSubmitButton(el: HTMLElement): boolean {
  if (!isVisible(el)) return false;
  if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  const haystack = [
    el.getAttribute('aria-label'),
    el.getAttribute('title'),
    el.getAttribute('data-testid'),
    el.textContent ?? '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return SUBMIT_HINTS.some((h) => haystack.includes(h));
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return false;
  const cs = window.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  return true;
}

/**
 * Look at the live DOM and synthesize an adapter on the fly.
 * Returns null when no plausible chatbot UI is present on the page.
 */
export function detectGenericChatbot(): AgentAdapter | null {
  // Find plausible inputs first.
  const inputs: Array<{ el: HTMLElement; strategy: WriteStrategy }> = [];
  const inputCandidates = document.querySelectorAll<HTMLElement>(
    'textarea, [contenteditable="true"]',
  );
  for (const el of Array.from(inputCandidates)) {
    const v = looksLikePromptInput(el);
    if (v?.ok) inputs.push({ el, strategy: v.strategy });
  }
  if (inputs.length === 0) return null;

  // Find a submit button close to one of those inputs (in DOM ancestor chain
  // OR the same parent form). The "best" input is the one with an actual
  // submit nearby.
  let bestInput: { el: HTMLElement; strategy: WriteStrategy } | null = null;
  let bestSubmit: HTMLElement | null = null;
  for (const candidate of inputs) {
    // Look up in the ancestor chain to find a container, then search submit
    // candidates inside that container.
    let scope: HTMLElement | null = candidate.el;
    for (let depth = 0; depth < 6 && scope; depth++) {
      const buttons = scope.querySelectorAll<HTMLElement>('button, [role="button"]');
      for (const b of Array.from(buttons)) {
        if (looksLikeSubmitButton(b)) {
          bestInput = candidate;
          bestSubmit = b;
          break;
        }
      }
      if (bestSubmit) break;
      scope = scope.parentElement;
    }
    if (bestSubmit) break;
  }
  if (!bestInput) return null;

  // Synthesize an adapter. We can't write CSS selectors that uniquely
  // identify these runtime elements, but `inputSelector` and `submitSelector`
  // are only used by findInput / findSubmit which both do `querySelectorAll`
  // + visibility — so a broad selector works fine in practice.
  const adapter: AgentAdapter = {
    hostname: window.location.hostname,
    label: 'Generic chatbot',
    inputSelector:
      bestInput.el.tagName === 'TEXTAREA'
        ? 'textarea'
        : 'div[contenteditable="true"], [contenteditable="true"]',
    writeStrategy: bestInput.strategy,
    submitSelector: bestSubmit
      ? `button[aria-label], button[title], button[data-testid], [role="button"]`
      : undefined,
  };
  return adapter;
}
