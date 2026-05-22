/**
 * "Save Q&A to Mesh" button below every assistant message.
 *
 * For each chatbot we know how to locate user vs. assistant message
 * bubbles. We watch the DOM with a MutationObserver, and whenever a new
 * assistant message appears we mount a small floating button at its
 * bottom-right corner. Click → grab the most recent user message above
 * the assistant turn and save both together as a single memory node.
 *
 * The previous question is critical context — saving just the answer
 * without the prompt that triggered it almost always loses meaning.
 *
 * Adapter-dependent: relies on userBubbleSelector + a per-host
 * assistantBubbleSelector we define inline (the previous adapter only
 * knew about user bubbles for the badge decoration).
 */

import type { AgentAdapter } from './injector';
import { safeSendMessage, runtimeIsAlive } from './runtime';
import { extractManual } from './extract';

interface ChatBubbleSelectors {
  user: string;
  assistant: string;
}

/**
 * Per-hostname selectors for assistant message bubbles. We reuse the
 * adapter.userBubbleSelector for the user side. Hostnames not listed get
 * a generic fallback that targets the second of each conversation-turn
 * pair when present.
 */
const ASSISTANT_SELECTORS: Record<string, string> = {
  'chatgpt.com': '[data-message-author-role="assistant"]',
  'chat.openai.com': '[data-message-author-role="assistant"]',
  'claude.ai': '[data-testid="assistant-message"], [data-is-streaming]',
  'gemini.google.com': 'model-response, message-content[data-role="model"]',
  'www.perplexity.ai': '[class*="prose"][class*="answer"], main article',
};

function selectorsFor(adapter: AgentAdapter): ChatBubbleSelectors | null {
  const userSel = adapter.userBubbleSelector;
  const assistantSel = ASSISTANT_SELECTORS[adapter.hostname];
  if (!userSel || !assistantSel) return null;
  return { user: userSel, assistant: assistantSel };
}

function ensureStyle(): void {
  if (document.getElementById('mesh-qa-save-style')) return;
  const s = document.createElement('style');
  s.id = 'mesh-qa-save-style';
  s.textContent = `
    .mesh-qa-save {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      padding: 4px 10px;
      background: transparent;
      color: #a3a3a3;
      border: 1px solid #2a2a2a;
      border-radius: 999px;
      font-size: 11px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      cursor: pointer;
      user-select: none;
      transition: color 120ms ease, border-color 120ms ease, background 120ms ease;
    }
    .mesh-qa-save:hover {
      color: #f5b301;
      border-color: #f5b301;
      background: rgba(245,179,1,0.06);
    }
    .mesh-qa-save.saved {
      color: #34d399;
      border-color: #14532d;
    }
    .mesh-qa-save.failed {
      color: #f87171;
      border-color: #7f1d1d;
    }
  `;
  document.head.appendChild(s);
}

function bubbleText(el: HTMLElement): string {
  return (el.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function saveQA(opts: {
  question: string;
  answer: string;
  hostname: string;
  button: HTMLButtonElement;
}): Promise<void> {
  const { question, answer, hostname, button } = opts;
  const labelEl = button.querySelector<HTMLSpanElement>('[data-label]');
  if (!runtimeIsAlive()) {
    button.classList.add('failed');
    if (labelEl) labelEl.textContent = 'Mesh unavailable';
    return;
  }
  if (labelEl) labelEl.textContent = 'Saving…';
  const content = `Q: ${question}\n\nA: ${answer}`;
  const extracted = extractManual(content, window.location.href);
  extracted.node_type = 'text';
  // Use the prompt text as a hint for the title — the server-side AI
  // title generator will refine it.
  extracted.title = question.slice(0, 120);
  const response = await safeSendMessage<{ ok?: boolean; decision?: string; error?: string }>({
    type: 'CAPTURE_SIGNAL',
    signal: {
      content,
      url: window.location.href,
      signalType: 'hover', // explicit user action
      dwellMs: 0,
      scrollDepth: 0,
    },
    metadata: {
      sourceApp: hostname,
      captureType: 'chatbot_qa',
      elementType: 'text',
      pageTitle: document.title,
      capturedAt: new Date().toISOString(),
      referrerUrl: document.referrer || null,
      qa: { question_chars: question.length, answer_chars: answer.length },
      extracted,
    },
  });
  if (response?.ok || response?.decision === 'queued') {
    button.classList.add('saved');
    if (labelEl) labelEl.textContent = 'Saved ✓';
  } else {
    button.classList.add('failed');
    if (labelEl) labelEl.textContent =
      response?.decision === 'duplicate' ? 'Already saved' : 'Failed';
  }
  setTimeout(() => {
    button.classList.remove('saved', 'failed');
    if (labelEl) labelEl.textContent = 'Save Q&A to Mesh';
  }, 2500);
}

/**
 * Decorate one assistant message with a save button. No-op if already
 * decorated.
 */
function decorate(adapter: AgentAdapter, selectors: ChatBubbleSelectors, assistantEl: HTMLElement): void {
  if (assistantEl.hasAttribute('data-mesh-qa-saved')) return;
  assistantEl.setAttribute('data-mesh-qa-saved', '1');

  // Find the user message that came right before this assistant turn.
  const userBubbles = document.querySelectorAll<HTMLElement>(selectors.user);
  let prevUser: HTMLElement | null = null;
  for (const u of Array.from(userBubbles)) {
    const pos = u.compareDocumentPosition(assistantEl);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
      prevUser = u; // u is before assistantEl
    } else {
      break;
    }
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-mesh-ui', 'qa-save');
  btn.className = 'mesh-qa-save';
  btn.innerHTML = '<span>📌</span><span data-label>Save Q&amp;A to Mesh</span>';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const question = prevUser ? bubbleText(prevUser) : '';
    const answer = bubbleText(assistantEl);
    if (!answer || answer.length < 20) return;
    saveQA({
      question: question || '(no preceding prompt found)',
      answer,
      hostname: adapter.hostname,
      button: btn,
    });
  });

  // Append at the end of the assistant message. Some chatbots already
  // have action buttons (copy, regenerate); inserting our button at the
  // bottom of the bubble keeps it grouped with the message itself.
  assistantEl.appendChild(btn);
}

/**
 * Install a MutationObserver that decorates every assistant message
 * (existing + future) with a "Save Q&A to Mesh" button.
 */
export function installChatbotSaveButtons(adapter: AgentAdapter): void {
  const selectors = selectorsFor(adapter);
  if (!selectors) {
    console.log('[Mesh] chatbot-save skipped — no assistant selector for', adapter.hostname);
    return;
  }
  ensureStyle();

  const scan = () => {
    if (!runtimeIsAlive()) return;
    try {
      document.querySelectorAll<HTMLElement>(selectors.assistant).forEach((el) => {
        // Only decorate fully-streamed responses (skip the in-progress
        // one to avoid the button jumping while text streams in). Most
        // chatbots remove a "streaming" attribute once done; we use a
        // crude heuristic instead: skip if text is < 40 chars (still
        // streaming) and the element is the last one.
        const text = (el.textContent ?? '').trim();
        if (text.length < 40) return;
        decorate(adapter, selectors, el);
      });
    } catch (err) {
      console.warn('[Mesh] chatbot-save scan failed', err);
    }
  };

  scan();
  const obs = new MutationObserver(() => scan());
  obs.observe(document.body, { childList: true, subtree: true });

  // Re-scan periodically in case the chatbot updates a streamed message
  // in place (text grows from 20 → 200 chars without firing childList
  // events the observer cares about).
  const interval = setInterval(scan, 2500);

  // Self-cleanup when runtime dies.
  const watchdog = setInterval(() => {
    if (!runtimeIsAlive()) {
      obs.disconnect();
      clearInterval(interval);
      clearInterval(watchdog);
      document.querySelectorAll<HTMLElement>('.mesh-qa-save').forEach((b) => b.remove());
    }
  }, 2000);
}
