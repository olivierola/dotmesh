import { db, getSetting } from '@/lib/db';
import { getAuth, ensureFreshAuth } from '@/lib/auth';
import { pushNode } from '@/lib/api-client';

interface Report {
  generated_at: string;
  config: Record<string, string | undefined>;
  auth: { signed_in: boolean; email?: string; token_expires_in_min?: number };
  api_reachable: { ok: boolean; status?: number; latency_ms?: number; error?: string };
  queue: { pending: number; sent: number; failed: number };
  last_error: string | null;
  paused: boolean;
}

function row(label: string, value: string, klass = '') {
  return `<div class="row"><span class="label">${escape(label)}</span><span class="value ${klass}">${escape(value)}</span></div>`;
}
function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function buildReport(): Promise<Report> {
  const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '(unset)';
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? '(unset)';
  const webUrl = (import.meta.env.VITE_PUBLIC_WEB_URL as string | undefined) ?? '(unset)';

  const auth = await getAuth();
  const [pending, sent, failed] = await Promise.all([
    db.queue.where('status').equals('pending').count(),
    db.queue.where('status').equals('sent').count(),
    db.queue.where('status').equals('failed').count(),
  ]);
  const lastError = await getSetting<string | null>('last_error', null);
  const paused = await getSetting<boolean>('paused', false);

  // Ping the API
  let api_reachable: Report['api_reachable'] = { ok: false };
  try {
    const start = performance.now();
    const refreshed = auth ? await ensureFreshAuth() : null;
    const res = await fetch(`${apiUrl}/nodes?limit=1`, {
      headers: refreshed
        ? { Authorization: `Bearer ${refreshed.accessToken}` }
        : {},
    });
    api_reachable = {
      ok: res.ok || res.status === 401, // 401 = endpoint up but no auth → still reachable
      status: res.status,
      latency_ms: Math.round(performance.now() - start),
    };
  } catch (e) {
    api_reachable = { ok: false, error: (e as Error).message };
  }

  return {
    generated_at: new Date().toISOString(),
    config: {
      VITE_SUPABASE_URL: supabaseUrl,
      VITE_API_URL: apiUrl,
      VITE_PUBLIC_WEB_URL: webUrl,
      extension_id: chrome.runtime.id,
      manifest_version: String(chrome.runtime.getManifest().manifest_version),
      version: chrome.runtime.getManifest().version,
    },
    auth: {
      signed_in: !!auth,
      email: auth?.email,
      token_expires_in_min: auth
        ? Math.round((auth.expiresAt - Date.now()) / 60_000)
        : undefined,
    },
    api_reachable,
    queue: { pending, sent, failed },
    last_error: lastError,
    paused,
  };
}

function render(report: Report) {
  // Config
  const cfg = document.getElementById('config')!;
  cfg.innerHTML = `
    ${row('Supabase URL', report.config.VITE_SUPABASE_URL ?? '')}
    ${row('API URL', report.config.VITE_API_URL ?? '')}
    ${row('Web URL', report.config.VITE_PUBLIC_WEB_URL ?? '')}
    ${row('Extension ID', report.config.extension_id ?? '')}
    ${row('Manifest', `MV${report.config.manifest_version}`)}
    ${row('Version', report.config.version ?? '')}
  `;

  // Auth
  const auth = document.getElementById('auth')!;
  auth.innerHTML = `
    ${row('Signed in', report.auth.signed_in ? 'Yes' : 'No', report.auth.signed_in ? 'ok' : 'err')}
    ${report.auth.email ? row('Account', report.auth.email) : ''}
    ${
      report.auth.token_expires_in_min !== undefined
        ? row(
            'Token expires',
            report.auth.token_expires_in_min > 5
              ? `in ${report.auth.token_expires_in_min} min`
              : 'soon (will refresh)',
            report.auth.token_expires_in_min > 5 ? 'ok' : 'warn',
          )
        : ''
    }
    ${row(
      'API reachable',
      report.api_reachable.ok
        ? `OK · ${report.api_reachable.status} (${report.api_reachable.latency_ms}ms)`
        : `FAIL · ${report.api_reachable.status ?? report.api_reachable.error ?? 'no response'}`,
      report.api_reachable.ok ? 'ok' : 'err',
    )}
  `;

  // Queue
  const q = document.getElementById('queue')!;
  q.innerHTML = `
    ${row('Pending', String(report.queue.pending), report.queue.pending > 5 ? 'warn' : '')}
    ${row('Successfully sent', String(report.queue.sent), 'ok')}
    ${row('Failed', String(report.queue.failed), report.queue.failed > 0 ? 'err' : '')}
    ${row('Paused', report.paused ? 'Yes' : 'No', report.paused ? 'warn' : '')}
    ${report.last_error ? row('Last error', report.last_error.slice(0, 200), 'err') : ''}
  `;

  // Raw JSON
  const raw = document.getElementById('raw')!;
  raw.textContent = JSON.stringify(report, null, 2);
}

async function init() {
  let report = await buildReport();
  render(report);

  document.getElementById('copy-report')!.addEventListener('click', async () => {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    const btn = document.getElementById('copy-report')!;
    btn.textContent = 'Copied ✓';
    setTimeout(() => (btn.textContent = 'Copy full report'), 1500);
  });

  document.getElementById('test-capture')!.addEventListener('click', async () => {
    const btn = document.getElementById('test-capture')! as HTMLButtonElement;
    const out = document.getElementById('test-result')! as HTMLPreElement;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    out.style.display = 'block';
    out.textContent = '';

    const start = performance.now();
    const result = await pushNode({
      content: `[Diagnostics test] sent from ${chrome.runtime.id} at ${new Date().toISOString()}`,
      source: 'extension',
      source_app: 'diagnostics',
      tags: ['diagnostic'],
      fingerprint: `diag-${Date.now()}`,
    });
    const elapsed = Math.round(performance.now() - start);

    if ('node_id' in result) {
      out.innerHTML = `<span class="ok">✓ Test capture saved (node ${result.node_id.slice(0, 8)}…) in ${elapsed}ms</span>`;
    } else {
      out.innerHTML = `<span class="err">✗ Failed: ${escape(result.error)}</span>\n\nDetails:\n${escape(JSON.stringify(result, null, 2))}`;
    }
    btn.textContent = 'Send test capture';
    btn.disabled = false;

    // Refresh report
    report = await buildReport();
    render(report);
  });
}

init();
