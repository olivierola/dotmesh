/**
 * Helpers to derive a clean, human-readable title + subtitle + favicon
 * for a captured node, regardless of whether the backend already ran LLM
 * cleanup on it. The goal is: never show a raw URL or a "[Page] https://…"
 * line in the UI again.
 */

import type { MockNode } from './mock';

export interface NodeDisplay {
  title: string;
  subtitle: string | null;
  body: string | null;
  host: string | null;
  faviconUrl: string | null;
  isLinkLike: boolean;
}

const HOST_LABELS: Record<string, string> = {
  'linkedin.com': 'LinkedIn',
  'www.linkedin.com': 'LinkedIn',
  'github.com': 'GitHub',
  'twitter.com': 'Twitter',
  'x.com': 'X',
  'reddit.com': 'Reddit',
  'youtube.com': 'YouTube',
  'www.youtube.com': 'YouTube',
  'chatgpt.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'gemini.google.com': 'Gemini',
  'www.perplexity.ai': 'Perplexity',
  'facebook.com': 'Facebook',
  'instagram.com': 'Instagram',
  'tiktok.com': 'TikTok',
  'amazon.com': 'Amazon',
  'medium.com': 'Medium',
  'substack.com': 'Substack',
  'notion.so': 'Notion',
  'www.notion.so': 'Notion',
  'stackoverflow.com': 'Stack Overflow',
};

function prettyHostLabel(host: string): string {
  const lower = host.toLowerCase();
  if (HOST_LABELS[lower]) return HOST_LABELS[lower];
  const stripped = lower.replace(/^www\./, '');
  if (HOST_LABELS[stripped]) return HOST_LABELS[stripped];
  // Title-case the second-level part: "stratechery.com" -> "Stratechery"
  const parts = stripped.split('.');
  const root = parts.length >= 2 ? parts[parts.length - 2]! : stripped;
  return root.charAt(0).toUpperCase() + root.slice(1);
}

function humanizePathSegment(seg: string): string {
  // Drop UUIDs, hashes, IDs, trailing extensions.
  if (/^[0-9a-f-]{16,}$/i.test(seg)) return '';
  if (/^\d{6,}$/.test(seg)) return '';
  return decodeURIComponent(seg)
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[-_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Heuristic title from a URL alone, when no captured title is available.
 * Example: https://linkedin.com/jobs/view/4405...  →  "LinkedIn — jobs view"
 *          https://taleez.com/apply/devops-ci-cd  →  "Taleez — apply devops ci cd"
 */
function titleFromUrl(rawUrl: string): { title: string; host: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname;
  const segs = u.pathname.split('/').map(humanizePathSegment).filter(Boolean);
  // Keep at most the first 3 meaningful segments — that's almost always the
  // "category / action / topic" tuple users actually want to read.
  const path = segs.slice(0, 3).join(' / ');
  const hostLabel = prettyHostLabel(host);
  if (!path) return { title: hostLabel, host };
  return { title: `${hostLabel} — ${path}`, host };
}

/**
 * Strip the noisy "[Page] https://…" / "[Image] …" prefix that the extension
 * uses internally for typed captures. Returns null if nothing useful remains.
 */
function stripTypedPrefix(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  const m = trimmed.match(/^\[(Page|Image|Video|Link|Quote|Code)\]\s*(.*)$/i);
  if (!m) return trimmed || null;
  const rest = m[2]!.trim();
  return rest || null;
}

/**
 * Returns true if the cleaned string is essentially a bare URL (or "host" or
 * "host/path") with no real natural-language content. Used to decide whether
 * to fall back to the URL-derived humanized title.
 */
function looksLikeBareUrl(s: string | null): boolean {
  if (!s) return true;
  const trimmed = s.trim();
  if (!trimmed) return true;
  if (/^https?:\/\/\S+$/i.test(trimmed)) return true;
  // host/path with no whitespace and at least one dot → bare URL fragment
  if (!/\s/.test(trimmed) && /\./.test(trimmed) && trimmed.length < 200) return true;
  return false;
}

/**
 * Site-specific boilerplate that the extension often captures from the page
 * chrome before the actual content. Stripped from the head of the body so
 * users don't see "Commencer un postVidéoPhotoRédiger un article…" etc.
 */
const NOISE_PREFIXES: RegExp[] = [
  /^Commencer un post[^.]*?(?=[A-Z][a-zéèà])/i,
  /^Sélectionnez la vue du fil[^.]*?(?=[A-Z][a-zéèà])/i,
  /^Skip to (main )?content[^.]{0,40}/i,
  /^Sign in to[^.]{0,80}/i,
  /^Accept (all )?cookies[^.]{0,80}/i,
  /^Reposting[^.]{0,40}/i,
];

const NOISE_GLOBAL: RegExp[] = [
  /\b#\w+(\s+#\w+){2,}/g, // long #hashtag chains at the end
];

/**
 * Inserts line breaks where the raw scrape glued sentences together.
 * Pattern: lowercase or punctuation immediately followed by an uppercase
 * letter is almost always a missing space/newline. We also normalize bullet
 * markers and emoji-numbered lists onto their own line.
 */
function reflow(text: string): string {
  let s = text;
  // Strip known noise prefixes
  for (const re of NOISE_PREFIXES) s = s.replace(re, '');
  // Strip noise globals (only when not the whole content)
  for (const re of NOISE_GLOBAL) s = s.replace(re, '');
  // Number-emoji enumerators 1️⃣ 2️⃣ … → newline before each
  s = s.replace(/\s*([1-9]\u{FE0F}?\u{20E3})/gu, '\n\n$1 ');
  // Bullet markers " • " / " · " → newline + bullet
  s = s.replace(/\s+[•·]\s+/g, '\n• ');
  // Sentence boundary that lost its space: ".A" / "?A" / "!A"
  s = s.replace(/([.!?])([A-ZÉÈÀ])/g, '$1 $2');
  // Paragraph boundary: lowercase letter immediately followed by capital +
  // lowercase (CamelCase glue from scraped DOM, e.g. "...la guerre.Une dépendance")
  s = s.replace(/([a-zéèà])\.\s*([A-ZÉÈÀ][a-zéèà])/g, '$1.\n\n$2');
  // Hashtag block at the end → own paragraph
  s = s.replace(/(\s)(#\w+(\s+#\w+){2,})\s*$/u, '\n\n$2');
  // Collapse 3+ blank lines
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function cleanBodyText(raw: string | null | undefined): string {
  if (!raw) return '';
  return reflow(raw);
}

export function displayForNode(n: MockNode): NodeDisplay {
  const md = n.metadata as Record<string, unknown> | undefined;
  const extracted = md?.extracted as
    | { title?: string | null; site_name?: string | null }
    | undefined;

  const rawTitle = stripTypedPrefix(extracted?.title ?? null);
  const rawSummary = stripTypedPrefix(n.summary ?? null);
  const rawContent = stripTypedPrefix(n.content ?? null);

  // Order of preference for the title: extracted.title > summary > content,
  // skipping anything that looks like a bare URL.
  let title: string | null = null;
  for (const candidate of [rawTitle, rawSummary, rawContent?.split('\n')[0] ?? null]) {
    if (candidate && !looksLikeBareUrl(candidate)) {
      title = candidate.slice(0, 160);
      break;
    }
  }

  // Body = a longer description distinct from the title. Suppress it when it
  // duplicates the title or is itself a bare URL. Reflow scraped HTML where
  // sentence breaks were lost.
  let body: string | null = null;
  if (rawSummary && rawSummary !== title && !looksLikeBareUrl(rawSummary)) {
    body = cleanBodyText(rawSummary);
  } else if (rawContent && rawContent !== title && !looksLikeBareUrl(rawContent)) {
    body = cleanBodyText(rawContent);
  }
  if (body && body === title) body = null;

  // Host + favicon
  let host: string | null = null;
  let faviconUrl: string | null = null;
  if (n.source_url) {
    try {
      const u = new URL(n.source_url);
      host = u.hostname;
      faviconUrl = `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
    } catch {
      /* ignore */
    }
  }
  if (!host && extracted?.site_name) host = extracted.site_name;

  // Final fallback: derive a title from the URL itself.
  if (!title && n.source_url) {
    const fromUrl = titleFromUrl(n.source_url);
    if (fromUrl) {
      title = fromUrl.title;
      host = host ?? fromUrl.host;
    }
  }
  if (!title) title = '(untitled memory)';

  // Subtitle: pretty host label
  const subtitle = host ? prettyHostLabel(host) : null;

  // Link-like = either we have a URL, or the original content was a bare URL.
  const isLinkLike =
    !!n.source_url ||
    (rawContent ? /^https?:\/\//i.test(rawContent.trim()) : false);

  return {
    title,
    subtitle,
    body: body && body !== title ? body : null,
    host,
    faviconUrl,
    isLinkLike,
  };
}
