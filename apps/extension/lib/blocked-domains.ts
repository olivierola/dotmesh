/**
 * Domain blocklist for sensitive sites. Hardcoded for legal categories
 * (health, banking, government, private messaging, mail). User can ADD to this
 * list via settings but cannot remove the hardcoded entries.
 */

const HARD_BLOCKED: Array<string | RegExp> = [
  // ---- Mesh itself ----
  // Never capture the app the user is reviewing their memory in — feedback loop.
  'dotmesh.vercel.app',
  /^https?:\/\/[^/]*dotmesh[^/]*\.vercel\.app/i,
  /^https?:\/\/localhost:5173/i,
  /^https?:\/\/127\.0\.0\.1:5173/i,

  // ---- Mail ----
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'mail.yahoo.com',
  'mail.proton.me',
  'protonmail.com',
  'tutanota.com',
  'tuta.com',
  'mail.aol.com',
  'icloud.com/mail',
  'fastmail.com',
  'hey.com',
  'zoho.com/mail',

  // ---- Private messaging ----
  'web.whatsapp.com',
  'messenger.com',
  'facebook.com/messages',
  'instagram.com/direct',
  'x.com/messages',
  'twitter.com/messages',
  'wa.me',
  'signal.org',
  'web.telegram.org',
  'discord.com/channels',
  'discord.com/app',
  'teams.microsoft.com',
  'meet.google.com',
  'zoom.us/wc',
  'zoom.us/j',

  // ---- Government (FR + EU + key intl) ----
  'impots.gouv.fr',
  'ameli.fr',
  'service-public.fr',
  'urssaf.fr',
  'cpam.fr',
  'caf.fr',
  'pole-emploi.fr',
  'france-travail.fr',
  'mon.service-public.fr',
  'msa.fr',
  'gov.uk',
  'irs.gov',
  'ssa.gov',
  'usa.gov',
  'europa.eu',

  // ---- Healthcare ----
  'doctolib.fr',
  'doctolib.de',
  'maiia.com',
  'mondossiermedical.fr',
  'sante.fr',
  'mes-remboursements.ameli.fr',
  'mychart.com',
  'patientportal.com',
  /^https?:\/\/[^/]*\.(mychart|patientportal)\./i,

  // ---- Banking / financial / crypto ----
  /^https?:\/\/[^/]*\.(mabanque|monespace|secure|onlinebanking|netbank|ebanking)\./i,
  'paypal.com',
  'stripe.com/dashboard',
  'wise.com',
  'revolut.com',
  'n26.com',
  'qonto.com',
  'shineapp.com',
  'fortuneo.fr',
  'boursorama.com',
  'societegenerale.fr',
  'creditmutuel.fr',
  'lcl.fr',
  'bnpparibas.net',
  'coinbase.com',
  'binance.com',
  'kraken.com',
  'metamask.io',
  'phantom.app',

  // ---- HR / payroll / sensitive corporate ----
  'workday.com',
  'silae.fr',
  'payfit.com',
  'lucca.fr',
  'bamboohr.com',
  'gusto.com',
  '1password.com',
  'bitwarden.com',
  'dashlane.com',
  'lastpass.com',
  /^https?:\/\/[^/]*\.lastpass\./i,

  // ---- Adult / very-sensitive ----
  /pornhub|xvideos|onlyfans|xnxx|redtube|xhamster/i,

  // ---- Other (porn-adjacent / cam) ----
  /chaturbate|cam4|stripchat/i,
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
