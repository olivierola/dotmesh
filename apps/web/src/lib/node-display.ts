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
  // duplicates the title or is itself a bare URL.
  let body: string | null = null;
  if (rawSummary && rawSummary !== title && !looksLikeBareUrl(rawSummary)) {
    body = rawSummary;
  } else if (rawContent && rawContent !== title && !looksLikeBareUrl(rawContent)) {
    body = rawContent;
  }

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
    body: body && body !== title ? body.slice(0, 800) : null,
    host,
    faviconUrl,
    isLinkLike,
  };
}
