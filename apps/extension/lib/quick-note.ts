/**
 * Floating "quick note" button.
 *
 * A small circular FAB pinned bottom-right on every non-blocked page.
 * Click → an inline composer panel opens above it with a textarea and a
 * Save button. Submission sends the text through the existing CAPTURE
 * pipeline as `source: extension`, `signalType: 'manual'`.
 *
 * Designed to be lightweight and out of the way:
 *   - hidden while the user is selecting text or focusing another input,
 *   - escape closes the panel,
 *   - auto-clears after a successful save with a short check animation.
 */

import { safeSendMessage, runtimeIsAlive } from './runtime';
import { extractManual } from './extract';

const HOST_ID = 'mesh-quick-note-host';

function buildShadow(): { host: HTMLDivElement; shadow: ShadowRoot } {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-mesh-ui', 'quick-note');
  Object.assign(host.style, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    zIndex: '2147483645',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  });
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .fab {
        width: 44px;
        height: 44px;
        border-radius: 999px;
        background: #f5b301;
        color: #0a0a0a;
        border: 0;
        font-size: 22px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 6px 18px rgba(245,179,1,0.35), 0 2px 6px rgba(0,0,0,0.25);
        transition: transform 140ms ease, box-shadow 140ms ease;
        display: grid;
        place-items: center;
      }
      .fab:hover {
        transform: translateY(-2px);
        box-shadow: 0 10px 22px rgba(245,179,1,0.45), 0 3px 8px rgba(0,0,0,0.3);
      }
      .panel {
        position: absolute;
        right: 0;
        bottom: 56px;
        width: 320px;
        background: #0a0a0a;
        color: #e5e5e5;
        border: 1px solid #2a2a2a;
        border-radius: 12px;
        padding: 14px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.6);
        display: none;
        animation: meshPop 140ms ease both;
      }
      .panel.open { display: block; }
      @keyframes meshPop {
        from { opacity: 0; transform: translateY(8px) scale(0.97); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      .panel header {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 10px;
      }
      .panel header .title { font-size: 12px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: #a3a3a3; }
      .panel header button.close {
        background: transparent; border: 0; color: #737373; font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1;
      }
      .panel header button.close:hover { color: #d4d4d4; }
      textarea {
        width: 100%;
        height: 110px;
        padding: 10px;
        background: #141414;
        border: 1px solid #1f1f1f;
        border-radius: 8px;
        color: #e5e5e5;
        font: inherit;
        font-size: 13px;
        line-height: 1.5;
        resize: vertical;
        outline: none;
        transition: border-color 120ms ease;
      }
      textarea:focus { border-color: #3a3a3a; }
      textarea::placeholder { color: #555; }
      .actions {
        display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px;
      }
      .actions button {
        padding: 6px 12px; border-radius: 6px; border: 1px solid #2a2a2a;
        background: transparent; color: #d4d4d4; cursor: pointer; font-size: 12px;
        transition: background 120ms ease, border-color 120ms ease;
      }
      .actions button:hover { border-color: #444; }
      .actions button.primary {
        background: #f5b301; color: #0a0a0a; border-color: #f5b301; font-weight: 600;
      }
      .actions button.primary:hover { background: #ffbe10; }
      .actions button:disabled { opacity: 0.5; cursor: not-allowed; }
      .status { font-size: 11px; color: #737373; margin-top: 6px; min-height: 14px; }
      .status.ok    { color: #34d399; }
      .status.err   { color: #f87171; }
    </style>

    <div class="panel" data-panel>
      <header>
        <span class="title">📝 Quick note</span>
        <button class="close" data-close>✕</button>
      </header>
      <textarea data-input placeholder="What do you want to remember?"></textarea>
      <div class="status" data-status></div>
      <div class="actions">
        <button data-cancel>Cancel</button>
        <button class="primary" data-save>Save</button>
      </div>
    </div>
    <button class="fab" data-fab title="Quick note">+</button>
  `;
  return { host, shadow };
}

let installed = false;

export function installQuickNote(): void {
  if (installed) return;
  installed = true;

  const { host, shadow } = buildShadow();
  const fab = shadow.querySelector<HTMLButtonElement>('[data-fab]')!;
  const panel = shadow.querySelector<HTMLDivElement>('[data-panel]')!;
  const input = shadow.querySelector<HTMLTextAreaElement>('[data-input]')!;
  const saveBtn = shadow.querySelector<HTMLButtonElement>('[data-save]')!;
  const cancelBtn = shadow.querySelector<HTMLButtonElement>('[data-cancel]')!;
  const closeBtn = shadow.querySelector<HTMLButtonElement>('[data-close]')!;
  const status = shadow.querySelector<HTMLDivElement>('[data-status]')!;

  function open(): void {
    panel.classList.add('open');
    setTimeout(() => input.focus(), 50);
  }
  function close(): void {
    panel.classList.remove('open');
    status.textContent = '';
    status.classList.remove('ok', 'err');
  }
  function setStatus(text: string, kind: 'ok' | 'err' | '' = ''): void {
    status.textContent = text;
    status.classList.toggle('ok', kind === 'ok');
    status.classList.toggle('err', kind === 'err');
  }

  async function save(): Promise<void> {
    const text = input.value.trim();
    if (text.length < 2) return;
    if (!runtimeIsAlive()) {
      setStatus('Mesh isn\'t available — refresh the tab.', 'err');
      return;
    }
    saveBtn.disabled = true;
    setStatus('Saving…');
    const extracted = extractManual(text, window.location.href);
    const response = await safeSendMessage<{ ok?: boolean; decision?: string; error?: string }>({
      type: 'CAPTURE_SIGNAL',
      signal: {
        content: text,
        url: window.location.href,
        signalType: 'hover', // treat the explicit "+" as a deliberate save
        dwellMs: 0,
        scrollDepth: 0,
      },
      metadata: {
        sourceApp: window.location.hostname,
        captureType: 'manual',
        elementType: 'text',
        pageTitle: document.title,
        capturedAt: new Date().toISOString(),
        referrerUrl: document.referrer || null,
        extracted,
      },
    });
    saveBtn.disabled = false;
    if (response?.ok || response?.decision === 'queued') {
      setStatus('Saved to Mesh ✓', 'ok');
      input.value = '';
      setTimeout(close, 900);
    } else {
      setStatus(
        `Save failed: ${response?.error ?? response?.decision ?? 'unknown'}`,
        'err',
      );
    }
  }

  fab.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  saveBtn.addEventListener('click', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
  });

  // Hide the panel if the user clicks anywhere outside (but keep the FAB).
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!panel.classList.contains('open')) return;
      const path = e.composedPath();
      if (path.includes(host)) return;
      close();
    },
    true,
  );
}
