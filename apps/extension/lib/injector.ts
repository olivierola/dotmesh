/**
 * Cross-agent prompt injector.
 *
 * Each adapter knows how to locate the prompt input on a chatbot site,
 * read the current draft, replace it, and (optionally) trigger submission.
 *
 * The hard part isn't routing — it's that every chatbot uses a different
 * rich-text editor: ChatGPT uses ProseMirror, Claude uses Lexical,
 * Gemini uses a custom rich-textarea, Mistral uses a plain textarea, etc.
 * Each needs a slightly different write strategy or the text won't stick
 * (React state ignores naive textContent assignments).
 *
 * Adapter quality goals:
 *   - inputSelector: list multiple selectors separated by commas (we try
 *     them in order) so a UI update doesn't kill the whole adapter.
 *   - submitSelector: optional. When the user clicks the submit button
 *     instead of pressing Enter, we want to intercept that too.
 *   - writeStrategy: drives writeDraft's behaviour for editors that
 *     don't play well with execCommand.
 */

export type WriteStrategy =
  | 'textarea'        // plain <textarea> + native setter
  | 'execCommand'     // contenteditable, document.execCommand('insertText')
  | 'lexical'         // Claude.ai uses Lexical — needs explicit paste event
  | 'prosemirror'     // ChatGPT and others — paste event also works best
  | 'gemini';         // gemini.google.com — rich-textarea custom element

export interface AgentAdapter {
  hostname: string;
  /** Comma-separated list of selectors. First match wins. */
  inputSelector: string;
  /** How to write into the editor. */
  writeStrategy: WriteStrategy;
  /** Selector(s) for the submit button. Optional. */
  submitSelector?: string;
  /** Pretty name for telemetry. */
  label?: string;
  /**
   * Comma-separated selector(s) that resolve to the user's own message
   * bubbles in the conversation. We pick the LAST matching element after
   * submission to render injected-item badges above its text.
   * Optional — adapters without this just won't decorate.
   */
  userBubbleSelector?: string;
  /**
   * Optional CSS selector (relative to the bubble) for the actual text
   * container. If omitted, the bubble itself is treated as the text node.
   */
  userBubbleTextSelector?: string;
}

export const AGENT_ADAPTERS: AgentAdapter[] = [
  // -- OpenAI ChatGPT --
  {
    hostname: 'chatgpt.com',
    label: 'ChatGPT',
    inputSelector:
      '#prompt-textarea, div[contenteditable="true"][data-virtualkeyboard="true"], div[contenteditable="true"]',
    writeStrategy: 'prosemirror',
    submitSelector:
      'button[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="Envoyer" i]',
    userBubbleSelector: '[data-message-author-role="user"]',
    // ChatGPT wraps the actual text in a child div; this selector targets it
    // when present so we can stick badges *above* the text rather than over it.
    userBubbleTextSelector: '[data-message-author-role="user"] .whitespace-pre-wrap, [data-message-author-role="user"]',
  },
  {
    hostname: 'chat.openai.com',
    label: 'ChatGPT (legacy)',
    inputSelector: '#prompt-textarea, textarea[placeholder]',
    writeStrategy: 'prosemirror',
    submitSelector:
      'button[data-testid="send-button"], button[aria-label*="Send" i]',
  },
  // -- Anthropic Claude --
  {
    hostname: 'claude.ai',
    label: 'Claude',
    inputSelector:
      'div[contenteditable="true"][role="textbox"], div[contenteditable="true"][data-virtualkeyboard], div[contenteditable="true"]',
    writeStrategy: 'lexical',
    submitSelector:
      'button[aria-label*="Send" i], button[aria-label*="Envoyer" i], button[data-testid="send-button"]',
    userBubbleSelector: '[data-testid="user-message"], div[data-test-render-count] [data-testid*="message"]',
  },
  // -- Google Gemini --
  {
    hostname: 'gemini.google.com',
    label: 'Gemini',
    inputSelector:
      'rich-textarea div[contenteditable="true"], rich-textarea textarea, div[contenteditable="true"][role="textbox"]',
    writeStrategy: 'gemini',
    submitSelector:
      'button[aria-label*="Send" i], button[aria-label*="Envoyer" i], mat-icon[data-mat-icon-name="send"]',
    userBubbleSelector: 'user-query, .user-query-bubble-with-background',
  },
  // -- Perplexity --
  {
    hostname: 'www.perplexity.ai',
    label: 'Perplexity',
    inputSelector:
      'textarea[placeholder*="Ask" i], textarea[placeholder*="Demand" i], textarea',
    writeStrategy: 'textarea',
    submitSelector: 'button[aria-label*="Submit" i], button[type="submit"]',
    userBubbleSelector: 'h1.group\\/query, [class*="user-query"]',
  },
  // -- Mistral (Le Chat) --
  {
    hostname: 'chat.mistral.ai',
    label: 'Le Chat',
    inputSelector:
      'textarea[placeholder], div[contenteditable="true"][role="textbox"], div[contenteditable="true"]',
    writeStrategy: 'execCommand',
    submitSelector:
      'button[type="submit"], button[aria-label*="Send" i], button[aria-label*="Envoyer" i]',
  },
  // -- xAI Grok --
  {
    hostname: 'grok.com',
    label: 'Grok',
    inputSelector:
      'textarea[placeholder], textarea, div[contenteditable="true"]',
    writeStrategy: 'textarea',
    submitSelector: 'button[type="submit"], button[aria-label*="Send" i]',
  },
  {
    hostname: 'x.com',
    label: 'Grok (X)',
    // Grok lives in a side panel on x.com — limit to the Grok composer when present.
    inputSelector:
      '[data-testid="GrokComposer"] textarea, [data-testid="GrokDrawer"] textarea, [data-testid="grok-input"] textarea',
    writeStrategy: 'textarea',
  },
  // -- Microsoft Copilot --
  {
    hostname: 'copilot.microsoft.com',
    label: 'Copilot',
    inputSelector:
      'textarea#userInput, textarea[placeholder], div[contenteditable="true"][role="textbox"]',
    writeStrategy: 'textarea',
    submitSelector: 'button[type="submit"], button[aria-label*="Submit" i]',
  },
  {
    hostname: 'm365.cloud.microsoft',
    label: 'Microsoft 365 Copilot',
    inputSelector:
      'div[contenteditable="true"][role="textbox"], textarea[placeholder]',
    writeStrategy: 'execCommand',
  },
  // -- DeepSeek --
  {
    hostname: 'chat.deepseek.com',
    label: 'DeepSeek',
    inputSelector:
      'textarea[placeholder*="Message" i], textarea#chat-input, textarea',
    writeStrategy: 'textarea',
    submitSelector:
      'div[role="button"][aria-label*="Send" i], button[type="submit"]',
  },
  // -- Phind --
  {
    hostname: 'www.phind.com',
    label: 'Phind',
    inputSelector:
      'textarea[name="q"], textarea[placeholder], textarea',
    writeStrategy: 'textarea',
    submitSelector: 'button[type="submit"]',
  },
  // -- You.com --
  {
    hostname: 'you.com',
    label: 'You.com',
    inputSelector:
      'textarea[data-testid="chat-input"], textarea#search-input-textarea, textarea',
    writeStrategy: 'textarea',
    submitSelector:
      'button[data-testid="chat-submit-button"], button[type="submit"]',
  },
  // -- Poe (Quora) --
  {
    hostname: 'poe.com',
    label: 'Poe',
    inputSelector:
      'textarea[class*="GrowingTextArea"], div[contenteditable="true"], textarea',
    writeStrategy: 'execCommand',
    submitSelector: 'button[class*="ChatMessageSendButton"], button[type="submit"]',
  },
  // -- HuggingChat --
  {
    hostname: 'huggingface.co',
    label: 'HuggingChat',
    // Only the chat route, not the full site.
    inputSelector:
      'form textarea[enterkeyhint="send"], form textarea[placeholder]',
    writeStrategy: 'textarea',
    submitSelector: 'form button[type="submit"]',
  },
  // -- Cohere Coral --
  {
    hostname: 'coral.cohere.com',
    label: 'Coral',
    inputSelector:
      'textarea[placeholder*="Message" i], textarea',
    writeStrategy: 'textarea',
    submitSelector: 'button[type="submit"]',
  },
  // -- Pi.ai (Inflection) --
  {
    hostname: 'pi.ai',
    label: 'Pi',
    inputSelector:
      'textarea[placeholder*="Talk to Pi" i], textarea[placeholder], textarea',
    writeStrategy: 'textarea',
    submitSelector: 'button[type="submit"]',
  },
  // -- Character.AI --
  {
    hostname: 'character.ai',
    label: 'Character.AI',
    inputSelector:
      'textarea[placeholder*="Type" i], textarea',
    writeStrategy: 'textarea',
    submitSelector: 'button[type="submit"], button[aria-label*="Send" i]',
  },
  // -- v0 (Vercel) --
  {
    hostname: 'v0.dev',
    label: 'v0',
    inputSelector:
      'textarea[placeholder], div[contenteditable="true"]',
    writeStrategy: 'execCommand',
    submitSelector: 'button[type="submit"], button[aria-label*="Send" i]',
  },
  // -- Lovable / Bolt-style --
  {
    hostname: 'lovable.dev',
    label: 'Lovable',
    inputSelector:
      'textarea[placeholder], div[contenteditable="true"]',
    writeStrategy: 'execCommand',
    submitSelector: 'button[type="submit"]',
  },
  {
    hostname: 'bolt.new',
    label: 'Bolt',
    inputSelector:
      'textarea[placeholder], div[contenteditable="true"]',
    writeStrategy: 'execCommand',
    submitSelector: 'button[type="submit"], button[aria-label*="Send" i]',
  },
];

/** Match a chatbot adapter for a hostname. Supports exact + subdomain match. */
export function findAdapter(hostname: string): AgentAdapter | null {
  const h = hostname.toLowerCase();
  return (
    AGENT_ADAPTERS.find(
      (a) => h === a.hostname || h.endsWith(`.${a.hostname}`),
    ) ?? null
  );
}

/**
 * Find the active prompt input element on the page.
 *
 * Strategy:
 *   - Iterate the comma-separated selector list in order.
 *   - For each selector, walk all matches and keep the LAST visible one
 *     that's actually in the viewport area (so we pick the live composer,
 *     not an off-screen hidden one from a closed conversation).
 */
export function findInput(adapter: AgentAdapter): HTMLElement | null {
  const selectors = adapter.inputSelector.split(',').map((s) => s.trim()).filter(Boolean);
  for (const sel of selectors) {
    let candidates: HTMLElement[] = [];
    try {
      candidates = Array.from(document.querySelectorAll<HTMLElement>(sel));
    } catch {
      continue;
    }
    // Walk back-to-front so the newest composer wins on multi-tab UIs.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      if (!el) continue;
      if (!isVisible(el)) continue;
      // Skip read-only elements that look like input but aren't actually editable.
      if (el.tagName === 'TEXTAREA') {
        const ta = el as HTMLTextAreaElement;
        if (ta.disabled || ta.readOnly) continue;
      }
      if (el.getAttribute('aria-disabled') === 'true') continue;
      return el;
    }
  }
  return null;
}

/** Visibility check: laid out, non-zero size, not hidden. */
function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return false;
  const cs = window.getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
  return true;
}

/**
 * Locate the most recently rendered user-message bubble in the chatbot UI.
 * Returns null if the adapter doesn't declare one, or no bubble is on screen.
 */
export function findLastUserBubble(adapter: AgentAdapter): HTMLElement | null {
  if (!adapter.userBubbleSelector) return null;
  const selectors = adapter.userBubbleSelector
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sel of selectors) {
    let candidates: HTMLElement[] = [];
    try {
      candidates = Array.from(document.querySelectorAll<HTMLElement>(sel));
    } catch {
      continue;
    }
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      if (!el) continue;
      if (!isVisible(el)) continue;
      return el;
    }
  }
  return null;
}

/** Find the submit button matching the adapter's submit selectors. */
export function findSubmit(adapter: AgentAdapter): HTMLElement | null {
  if (!adapter.submitSelector) return null;
  const selectors = adapter.submitSelector.split(',').map((s) => s.trim()).filter(Boolean);
  for (const sel of selectors) {
    try {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(sel));
      for (let i = candidates.length - 1; i >= 0; i--) {
        const el = candidates[i];
        if (el && isVisible(el)) return el;
      }
    } catch {
      /* invalid selector — skip */
    }
  }
  return null;
}

/** Read the current draft. Works for both textarea and contenteditable. */
export function readDraft(adapter: AgentAdapter, el: HTMLElement): string {
  if (adapter.writeStrategy === 'textarea' || el.tagName === 'TEXTAREA') {
    return (el as HTMLTextAreaElement).value ?? '';
  }
  // contenteditable family
  return (el.innerText ?? el.textContent ?? '').trim();
}

/**
 * Replace the draft with `newText`, using the strategy that fits the editor.
 *
 * Why we don't have one universal strategy:
 *   - `<textarea>` requires the React-aware native value setter or React
 *     won't see the change.
 *   - ProseMirror + Lexical ignore execCommand on some recent builds; the
 *     reliable path is to dispatch a synthetic `paste` event so the editor
 *     processes the text through its normal input pipeline.
 *   - Gemini's rich-textarea is a custom element with its own input event.
 */
export function writeDraft(adapter: AgentAdapter, el: HTMLElement, newText: string): void {
  switch (adapter.writeStrategy) {
    case 'textarea':
      return writeTextarea(el, newText);
    case 'lexical':
    case 'prosemirror':
      return writeViaPaste(el, newText);
    case 'gemini':
      return writeGemini(el, newText);
    case 'execCommand':
    default:
      return writeContentEditable(el, newText);
  }
}

function writeTextarea(el: HTMLElement, newText: string): void {
  const ta = el as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  if (setter) {
    setter.call(ta, newText);
  } else {
    ta.value = newText;
  }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  ta.focus();
  ta.setSelectionRange(newText.length, newText.length);
}

/**
 * Paste-event strategy. Works for ProseMirror, Lexical, Slate and most other
 * rich-text editors that listen for paste to ingest external content.
 */
function writeViaPaste(el: HTMLElement, newText: string): void {
  el.focus();
  // Select all existing text first so the paste replaces it.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);

  // Some editors handle deletion themselves on paste; others need an explicit
  // delete event. Do both for safety.
  try {
    document.execCommand('delete');
  } catch {
    /* ignore */
  }

  // Build a real DataTransfer for the paste event payload.
  const dt = new DataTransfer();
  dt.setData('text/plain', newText);
  const paste = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  });
  const handled = el.dispatchEvent(paste);

  // If the editor swallowed the paste event but didn't insert text (some
  // hardened wrappers), fall back to execCommand insertText.
  const after = (el.textContent ?? '').trim();
  if (!handled || after.length === 0) {
    try {
      document.execCommand('insertText', false, newText);
    } catch {
      el.textContent = newText;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  }
}

function writeContentEditable(el: HTMLElement, newText: string): void {
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);

  try {
    document.execCommand('insertText', false, newText);
  } catch {
    el.textContent = newText;
  }
  if ((el.textContent ?? '').trim() === '') {
    el.textContent = newText;
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
}

function writeGemini(el: HTMLElement, newText: string): void {
  if (el.tagName === 'TEXTAREA') return writeTextarea(el, newText);
  // Gemini's contenteditable lives inside a <rich-textarea> custom element
  // that listens for `input` events on its own host. Setting textContent +
  // firing input is enough on the current build.
  el.focus();
  el.textContent = newText;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  // Move caret to end so a subsequent Enter submits.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);
}
