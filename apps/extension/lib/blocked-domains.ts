/**
 * Domain blocklist for sensitive sites. Hardcoded for legal categories
 * (health, banking, government, private messaging, mail). User can ADD to this
 * list via settings but cannot remove the hardcoded entries.
 */

const HARD_BLOCKED: Array<string | RegExp> = [
  // Mesh itself — never capture the app the user is reviewing their memory in,
  // otherwise we create a feedback loop (you read a Mesh page, the extension
  // captures it, that capture shows up on the page, you read it again…).
  'dotmesh.vercel.app',
  /^https?:\/\/[^/]*dotmesh[^/]*\.vercel\.app/i,
  /^https?:\/\/localhost:5173/i,
  /^https?:\/\/127\.0\.0\.1:5173/i,
  // Mail
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'protonmail.com',
  'tutanota.com',
  'tuta.com',
  // Government (FR-centric, extensible per locale)
  'impots.gouv.fr',
  'ameli.fr',
  'service-public.fr',
  'urssaf.fr',
  'cpam.fr',
  // Healthcare
  'doctolib.fr',
  'sante.fr',
  // Messaging (private)
  'facebook.com/messages',
  'instagram.com/direct',
  'wa.me',
  'web.whatsapp.com',
  'signal.org',
  'discord.com/channels',
  // Banking (heuristic — most banks use these in subdomains)
  /^https?:\/\/[^/]*\.(mabanque|monespace|secure|onlinebanking)\./i,
  // Adult / very-sensitive
  /pornhub|xvideos|onlyfans/i,
];

export async function isDomainBlocked(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // can't parse → safer to block
  }
  const haystack = parsed.host + parsed.pathname;
  for (const rule of HARD_BLOCKED) {
    if (typeof rule === 'string') {
      if (haystack === rule || haystack.startsWith(rule + '/') || parsed.host === rule) {
        return true;
      }
    } else if (rule.test(url)) {
      return true;
    }
  }

  // User-added domains (loaded from extension storage)
  try {
    const { db } = await import('./db');
    const setting = await db.settings.get('extra_blocked_domains');
    const extra = (setting?.value as string[] | undefined) ?? [];
    for (const e of extra) {
      if (parsed.host === e || parsed.host.endsWith('.' + e)) return true;
    }
  } catch {
    /* ignore */
  }

  return false;
}
