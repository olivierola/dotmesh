/**
 * Resend transactional email helpers.
 * No-op if RESEND_API_KEY missing.
 *
 * Templates live as functions so they can take strongly-typed params.
 */

const RESEND_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM = Deno.env.get('RESEND_FROM') ?? 'Mesh <hello@mesh.so>';
const REPLY_TO = Deno.env.get('RESEND_REPLY_TO') ?? '';
const WEB_URL = Deno.env.get('PUBLIC_WEB_URL') ?? 'https://mesh.so';

interface SendOpts {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(opts: SendOpts): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!RESEND_KEY) {
    console.log('[email mock]', opts.to, opts.subject);
    return { ok: true, id: 'mock' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [opts.to],
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        ...(REPLY_TO ? { reply_to: REPLY_TO } : {}),
      }),
    });
    if (!res.ok) return { ok: false, error: `${res.status}: ${await res.text()}` };
    const data = (await res.json()) as { id: string };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---------------- Shared template chrome ----------------

function layout(title: string, body: string): { html: string; text: string } {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e5e5;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#171717;border:1px solid #262626;border-radius:12px;padding:32px;">
    <div style="font-size:20px;font-weight:600;letter-spacing:-0.5px;margin-bottom:24px;">
      mesh<span style="color:#f5b301">.</span>
    </div>
    ${body}
    <hr style="border:none;border-top:1px solid #262626;margin:32px 0 16px;">
    <p style="font-size:11px;color:#737373;margin:0;">
      Mesh is EU-hosted (Frankfurt). You can <a href="${WEB_URL}/settings" style="color:#a3a3a3;">manage your account</a> or <a href="${WEB_URL}/settings" style="color:#a3a3a3;">delete it</a> at any time.
    </p>
  </div>
</body></html>`;
  const text = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { html, text };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------------- Templates ----------------

export async function sendWelcomeEmail(to: string, displayName?: string): Promise<void> {
  const name = displayName ?? to.split('@')[0] ?? 'there';
  const body = `
    <h2 style="font-size:18px;margin:0 0 16px;">Welcome to Mesh, ${escapeHtml(name)}.</h2>
    <p style="line-height:1.6;color:#d4d4d4;">
      Your second brain is set up. Here's what to do next:
    </p>
    <ol style="line-height:1.8;color:#d4d4d4;padding-left:20px;">
      <li>Install the <a href="${WEB_URL}/onboarding" style="color:#f5b301;">browser extension</a> (30 seconds).</li>
      <li>Read or chat with an AI agent — Mesh captures the rest.</li>
      <li>Open the <a href="${WEB_URL}/dashboard" style="color:#f5b301;">dashboard</a> to see your first memories.</li>
    </ol>
    <p style="line-height:1.6;color:#a3a3a3;font-size:13px;">
      Privacy promise: your data lives in the EU and you can wipe it in one click.
    </p>
  `;
  const { html, text } = layout('Welcome to Mesh', body);
  await sendEmail({ to, subject: 'Welcome to Mesh', html, text });
}

export async function sendAccountDeletionScheduled(to: string, hardDeleteAt: string): Promise<void> {
  const when = new Date(hardDeleteAt).toLocaleString('en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
  });
  const body = `
    <h2 style="font-size:18px;margin:0 0 16px;">Account deletion scheduled</h2>
    <p style="line-height:1.6;color:#d4d4d4;">
      As you requested, your Mesh account and all its data will be permanently deleted on:
    </p>
    <p style="background:#0a0a0a;border:1px solid #262626;border-radius:6px;padding:12px;font-family:monospace;">
      ${escapeHtml(when)}
    </p>
    <p style="line-height:1.6;color:#d4d4d4;">
      If you change your mind, simply sign back in before that date — the deletion will be cancelled.
    </p>
  `;
  const { html, text } = layout('Account deletion scheduled', body);
  await sendEmail({ to, subject: 'Mesh — account deletion scheduled', html, text });
}

export async function sendWeeklyDigest(
  to: string,
  data: {
    weekStart: string;
    narrative: string | null;
    topThemes: string[];
    topPeople: string[];
    nodeCount: number;
  },
): Promise<void> {
  const body = `
    <h2 style="font-size:18px;margin:0 0 16px;">Your week on Mesh — ${escapeHtml(data.weekStart)}</h2>
    <p style="line-height:1.6;color:#d4d4d4;">${
      data.narrative
        ? escapeHtml(data.narrative)
        : `You captured ${data.nodeCount} new memories this week.`
    }</p>
    ${
      data.topThemes.length
        ? `<p style="color:#a3a3a3;font-size:13px;margin:16px 0 4px;">Top themes</p>
           <p style="color:#e5e5e5;">${data.topThemes.map(escapeHtml).join(' · ')}</p>`
        : ''
    }
    ${
      data.topPeople.length
        ? `<p style="color:#a3a3a3;font-size:13px;margin:16px 0 4px;">Key people</p>
           <p style="color:#e5e5e5;">${data.topPeople.map(escapeHtml).join(' · ')}</p>`
        : ''
    }
    <p style="margin-top:24px;"><a href="${WEB_URL}/insights" style="background:#f5b301;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600;">Open full digest →</a></p>
  `;
  const { html, text } = layout('Your week on Mesh', body);
  await sendEmail({ to, subject: `Your week on Mesh — ${data.weekStart}`, html, text });
}
