/**
 * Inline confirmation overlay shown above the agent's prompt input.
 * Built in a Shadow DOM root to avoid CSS conflicts with the host page.
 */

export interface OverlayHandlers {
  onAccept: () => void;
  onSkip: () => void;
  onEdit: () => void;
}

export interface OverlayContent {
  nodeCount: number;
  previews: string[]; // short bullet lines
  agentHostname: string;
  autoAcceptMs: number;
}

const HOST_ID = 'mesh-injection-overlay-host';

export function mountOverlay(content: OverlayContent, handlers: OverlayHandlers): () => void {
  // Cleanup any previous
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  Object.assign(host.style, {
    position: 'fixed',
    bottom: '120px',
    right: '24px',
    zIndex: '2147483647',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  });
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        width: 340px;
        background: #0a0a0a;
        color: #e5e5e5;
        border: 1px solid #2a2a2a;
        border-radius: 10px;
        padding: 14px 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        font-size: 13px;
        line-height: 1.45;
      }
      .head { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
      .title { font-weight:600; }
      .badge { font-size:10px; color:#a3a3a3; background:#1a1a1a; padding:2px 6px; border-radius:4px; }
      ul { list-style:none; padding:0; margin:8px 0; }
      li { padding:4px 0; border-bottom:1px solid #1f1f1f; color:#d4d4d4; }
      li:last-child { border-bottom:none; }
      .actions { display:flex; gap:6px; margin-top:10px; }
      button {
        flex:1; padding:6px 10px; border-radius:6px; border:1px solid #2a2a2a;
        background:transparent; color:#d4d4d4; cursor:pointer; font-size:12px;
      }
      button.primary { background:#7c3aed; color:white; border-color:#7c3aed; }
      button:hover { border-color:#444; }
      .countdown { font-size:10px; color:#737373; margin-top:6px; text-align:right; }
    </style>
    <div class="card">
      <div class="head">
        <div class="title">Mesh found ${content.nodeCount} relevant ${content.nodeCount === 1 ? 'memory' : 'memories'}</div>
        <div class="badge">${content.agentHostname}</div>
      </div>
      <ul>
        ${content.previews.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}
      </ul>
      <div class="actions">
        <button class="primary" data-action="accept">Inject</button>
        <button data-action="edit">Edit</button>
        <button data-action="skip">Skip</button>
      </div>
      <div class="countdown" data-countdown></div>
    </div>
  `;

  const cleanup = () => {
    host.remove();
    if (timer) clearInterval(timer);
  };

  shadow.querySelector('[data-action="accept"]')?.addEventListener('click', () => {
    cleanup();
    handlers.onAccept();
  });
  shadow.querySelector('[data-action="skip"]')?.addEventListener('click', () => {
    cleanup();
    handlers.onSkip();
  });
  shadow.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
    cleanup();
    handlers.onEdit();
  });

  let remainingMs = content.autoAcceptMs;
  const countdownEl = shadow.querySelector('[data-countdown]') as HTMLElement | null;
  const tick = () => {
    if (countdownEl) {
      countdownEl.textContent =
        remainingMs > 0 ? `auto-inject in ${Math.ceil(remainingMs / 1000)}s` : '';
    }
  };
  tick();
  const timer = setInterval(() => {
    remainingMs -= 250;
    tick();
    if (remainingMs <= 0) {
      cleanup();
      handlers.onAccept();
    }
  }, 250);

  return cleanup;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
