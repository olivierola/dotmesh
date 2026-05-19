/**
 * Heuristic content extraction.
 *
 * Produces the canonical `Extracted` JSON shape that every captured node
 * carries under `metadata.extracted`. The same shape is consumed by the
 * Edge Function `process-node` (which fills in gaps with an LLM fallback)
 * and by the web app sidebar.
 *
 * Sources, in priority order:
 *   1. JSON-LD <script type="application/ld+json"> (schema.org Article, etc.)
 *   2. Open Graph + Twitter Card meta tags
 *   3. Standard <meta name="author|description|keywords"> tags
 *   4. <title>, the captured element itself, surrounding DOM
 *
 * No network calls — runs entirely on the page DOM at capture time.
 */

export type NodeType =
  | 'text'
  | 'image'
  | 'video'
  | 'link'
  | 'code'
  | 'quote'
  | 'page'
  | 'action';

export interface ExtractedAction {
  /** "save" = explicit Mesh hover-button click, "page-view" = passive view, etc. */
  kind: 'save' | 'page-view' | 'highlight' | 'click' | 'dwell' | 'scroll';
  /** Selector / xpath / textual value associated with the action. */
  value?: string | null;
  /** ISO timestamp. */
  at: string;
}

export interface Extracted {
  node_type: NodeType;
  title: string | null;
  description: string | null;
  author: string | null;
  /** Canonical body — text content, transcript, code, etc. May be truncated. */
  content: string | null;
  media_url: string | null;
  media_thumbnail: string | null;
  /** BCP-47 lowercased ('en', 'fr', 'fr-ca'). */
  lang: string | null;
  site_name: string | null;
  published_at: string | null;
  keywords: string[];
  actions: ExtractedAction[];
  source_extracted_at: string;
  extraction_method: 'heuristic' | 'llm' | 'mixed' | 'manual';
  /** <link rel="canonical"> if present — used by process-node to dedup pages
   *  across mirrors (twitter.com vs x.com, AMP, locale-prefixed, etc.). */
  canonical_url?: string | null;
  /** Word count of `content` after cleaning. */
  word_count?: number | null;
  /** Estimated reading time in minutes (230 wpm), null when not text-like. */
  reading_time_minutes?: number | null;
}

const MAX_CONTENT_CHARS = 8000;
const MAX_KEYWORDS = 20;

function metaContent(name: string): string | null {
  const sel = `meta[name="${name}" i], meta[property="${name}" i]`;
  const el = document.querySelector<HTMLMetaElement>(sel);
  const v = el?.content?.trim();
  return v && v.length > 0 ? v : null;
}

function og(prop: string): string | null {
  const el = document.querySelector<HTMLMetaElement>(`meta[property="og:${prop}" i]`);
  const v = el?.content?.trim();
  return v && v.length > 0 ? v : null;
}

function twitter(prop: string): string | null {
  const el = document.querySelector<HTMLMetaElement>(`meta[name="twitter:${prop}" i]`);
  const v = el?.content?.trim();
  return v && v.length > 0 ? v : null;
}

function jsonLd(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const nodes = document.querySelectorAll<HTMLScriptElement>(
    'script[type="application/ld+json"]',
  );
  for (const s of Array.from(nodes)) {
    try {
      const parsed = JSON.parse(s.textContent ?? '') as unknown;
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (item && typeof item === 'object') out.push(item as Record<string, unknown>);
      }
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

function ldAuthor(items: Record<string, unknown>[]): string | null {
  for (const item of items) {
    const a = item.author;
    if (!a) continue;
    if (typeof a === 'string') return a;
    if (typeof a === 'object' && a !== null) {
      const name = (a as { name?: unknown }).name;
      if (typeof name === 'string') return name;
    }
    if (Array.isArray(a)) {
      const names = a
        .map((x) =>
          typeof x === 'string' ? x : (x as { name?: string } | null)?.name ?? null,
        )
        .filter((x): x is string => !!x);
      if (names.length > 0) return names.join(', ');
    }
  }
  return null;
}

function ldPublished(items: Record<string, unknown>[]): string | null {
  for (const item of items) {
    const d =
      (item.datePublished as string | undefined) ??
      (item.dateCreated as string | undefined) ??
      (item.uploadDate as string | undefined);
    if (typeof d === 'string') return d;
  }
  return null;
}

function languageFromDom(): string | null {
  const root = document.documentElement.lang || document.querySelector('html')?.getAttribute('xml:lang');
  if (root && typeof root === 'string') return root.toLowerCase();
  return null;
}

function keywordsFromDom(): string[] {
  const meta = metaContent('keywords');
  if (!meta) return [];
  return meta
    .split(/[,;]/)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0 && k.length <= 50)
    .slice(0, MAX_KEYWORDS);
}

/** Collect up to N nearest text siblings to give an image/video context. */
function surroundingText(el: HTMLElement, maxLen = 600): string {
  const parent = el.parentElement;
  if (!parent) return '';
  let text = '';
  for (const child of Array.from(parent.children)) {
    if (child === el) continue;
    if (child.matches('script, style, [data-mesh-ui]')) continue;
    const t = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t.length > 20) text += t + ' ';
    if (text.length > maxLen) break;
  }
  return text.slice(0, maxLen).trim();
}

function findHeading(el: HTMLElement): string | null {
  // Closest article/section heading
  const article = el.closest('article, section, main, [role="article"]');
  const h = article?.querySelector('h1, h2');
  const text = h?.textContent?.trim();
  return text && text.length > 2 ? text : null;
}

/** rel=canonical → stable URL for dedup across mirrors / AMP / locale prefixes. */
function canonicalUrl(): string | null {
  const link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  const href = link?.href?.trim();
  if (!href) return null;
  try {
    const u = new URL(href);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Best-effort author detection that goes beyond the basic meta tags.
 * Tries, in order:
 *   - JSON-LD author (already covered upstream),
 *   - <meta name="author|byl|dc.creator">,
 *   - <link rel="author">,
 *   - elements with rel="author" / class containing "author"/"byline",
 *   - <address class="author">.
 */
function findAuthor(): string | null {
  const meta =
    metaContent('author') ??
    metaContent('byl') ??
    metaContent('byline') ??
    metaContent('dc.creator') ??
    metaContent('article:author') ??
    og('article:author');
  if (meta) return meta.trim();

  const relAuthor = document.querySelector<HTMLAnchorElement>('a[rel="author"], link[rel="author"]');
  const relText = relAuthor?.textContent?.trim() || relAuthor?.getAttribute('title')?.trim();
  if (relText) return relText;

  const candidates = document.querySelectorAll<HTMLElement>(
    [
      '[itemprop="author"]',
      '[itemprop="name"][itemtype*="Person" i]',
      '.byline',
      '.author',
      '.post-author',
      '.entry-author',
      'address.author',
      'address[rel="author"]',
    ].join(','),
  );
  for (const el of Array.from(candidates).slice(0, 5)) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length >= 2 && text.length <= 80 && !/^(by|par|de)\s*$/i.test(text)) {
      // Strip leading "By " / "Par " prefixes some bylines carry.
      return text.replace(/^(by|par|de)\s+/i, '');
    }
  }
  return null;
}

/**
 * Pick the most likely body container on the page.
 *
 * Heuristic: prefer semantic landmarks (<article>, [role=article], <main>),
 * then fall back to the element with the highest paragraph density × text
 * length score among page-level containers. Avoids picking <nav>, <aside>,
 * <header>, <footer> — these are penalised even if they contain text.
 */
function pickBodyRoot(): HTMLElement {
  const semantic = document.querySelector<HTMLElement>(
    'article, [role="article"], main, [role="main"], [itemprop="articleBody"]',
  );
  if (semantic && (semantic.textContent ?? '').length > 200) return semantic;

  const NEGATIVE = /(^|\s)(nav|aside|header|footer|sidebar|comment|menu|ad|advert|cookie|banner|promo)(\s|$)/i;
  const blocks = document.querySelectorAll<HTMLElement>('section, div, main');
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const b of Array.from(blocks)) {
    if (NEGATIVE.test(b.className) || NEGATIVE.test(b.id)) continue;
    const ps = b.querySelectorAll('p');
    if (ps.length < 2) continue;
    const text = (b.textContent ?? '').length;
    if (text < 400) continue;
    const score = text * Math.log(1 + ps.length);
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best ?? document.body;
}

/**
 * Clean the textContent of a container: drop scripts/styles/forms/ads, keep
 * paragraph-like flow and collapse whitespace.
 */
function readBodyText(root: HTMLElement, maxLen: number): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      'script, style, noscript, svg, form, button, nav, aside, header, footer, [data-mesh-ui], [class*="ad-" i], [class*="advert" i], [class*="cookie" i], [class*="banner" i]',
    )
    .forEach((n) => n.parentNode?.removeChild(n));
  return (clone.textContent ?? '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLen);
}

function countWords(text: string | null): number {
  if (!text) return 0;
  return (text.match(/\b[\p{L}\p{N}'-]+\b/gu) ?? []).length;
}

/**
 * Page-level base extraction — same for every capture on this page.
 */
export function extractPageBase(): Omit<
  Extracted,
  'node_type' | 'content' | 'media_url' | 'media_thumbnail' | 'actions'
> {
  const ld = jsonLd();

  const title =
    og('title') ??
    twitter('title') ??
    (ld[0]?.headline as string | undefined) ??
    document.title ??
    null;

  const description =
    og('description') ??
    twitter('description') ??
    metaContent('description') ??
    (ld[0]?.description as string | undefined) ??
    null;

  const author = ldAuthor(ld) ?? findAuthor();

  const site_name = og('site_name') ?? window.location.hostname;

  const published_at =
    ldPublished(ld) ??
    metaContent('article:published_time') ??
    og('article:published_time') ??
    metaContent('date') ??
    null;

  const lang = languageFromDom();
  const keywords = keywordsFromDom();
  const canonical = canonicalUrl();

  return {
    title: title?.trim() || null,
    description: description?.trim() || null,
    author: author?.trim() || null,
    lang,
    site_name: site_name?.trim() || null,
    published_at,
    keywords,
    source_extracted_at: new Date().toISOString(),
    extraction_method: 'heuristic',
    canonical_url: canonical,
    word_count: null,
    reading_time_minutes: null,
  };
}

/**
 * Extract a captured element (image, video, link, text...) into Extracted.
 */
export function extractFromElement(
  el: HTMLElement,
  declaredType: NodeType,
): Extracted {
  const base = extractPageBase();
  const actions: ExtractedAction[] = [
    { kind: 'save', value: declaredType, at: new Date().toISOString() },
  ];

  if (declaredType === 'image') {
    const img =
      el.tagName === 'IMG'
        ? (el as HTMLImageElement)
        : el.querySelector('img');
    const src = img?.currentSrc || img?.src || '';
    const alt = img?.alt?.trim() || '';
    const caption =
      el.closest('figure')?.querySelector('figcaption')?.textContent?.trim() ?? '';
    const context = surroundingText(el, 800);
    return {
      ...base,
      node_type: 'image',
      title: alt || caption || base.title,
      description: caption || context || base.description,
      content: [alt, caption, context].filter(Boolean).join('\n\n') || null,
      media_url: src || null,
      media_thumbnail: src || null,
      actions,
    };
  }

  if (declaredType === 'video') {
    const v = el as HTMLVideoElement;
    const src = v.currentSrc || v.src || '';
    const poster = v.poster || '';
    const context = surroundingText(el, 800);
    return {
      ...base,
      node_type: 'video',
      title: base.title,
      description: context || base.description,
      content: context || null,
      media_url: src || null,
      media_thumbnail: poster || null,
      actions,
    };
  }

  if (declaredType === 'link') {
    const a = el as HTMLAnchorElement;
    const text = (a.textContent ?? '').trim();
    return {
      ...base,
      node_type: 'link',
      title: text || base.title,
      description: base.description,
      content: text || null,
      media_url: a.href || null,
      media_thumbnail: null,
      actions,
    };
  }

  if (declaredType === 'code') {
    const code = (el.textContent ?? '').slice(0, MAX_CONTENT_CHARS);
    const lang =
      el.className.match(/language-([a-z0-9+#-]+)/i)?.[1] ??
      el.getAttribute('data-language') ??
      null;
    return {
      ...base,
      node_type: 'code',
      title: base.title ?? (lang ? `${lang} snippet` : 'Code'),
      description: base.description,
      content: code,
      media_url: null,
      media_thumbnail: null,
      lang: lang ?? base.lang,
      actions,
    };
  }

  if (declaredType === 'quote') {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS);
    return {
      ...base,
      node_type: 'quote',
      title: base.title,
      description: text.slice(0, 200),
      content: text,
      media_url: null,
      media_thumbnail: null,
      actions,
    };
  }

  // text / heading / list-item / generic
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS);
  const heading = findHeading(el);
  const words = countWords(text);
  return {
    ...base,
    node_type: 'text',
    title: heading ?? base.title,
    description: base.description ?? text.slice(0, 200),
    content: text || null,
    media_url: null,
    media_thumbnail: null,
    actions,
    word_count: words || null,
    reading_time_minutes: words > 30 ? Math.max(1, Math.round(words / 230)) : null,
  };
}

/**
 * Whole-page capture (used by "Save this page" context menu / quick capture).
 * Uses pickBodyRoot + readBodyText for a cleaner body than dumping <body>.
 */
export function extractPage(): Extracted {
  const base = extractPageBase();
  const root = pickBodyRoot();
  const content = readBodyText(root, MAX_CONTENT_CHARS);
  const words = countWords(content);
  const ogImage = og('image') ?? twitter('image') ?? null;
  return {
    ...base,
    node_type: 'page',
    content: content || null,
    media_url: null,
    media_thumbnail: ogImage,
    actions: [{ kind: 'save', value: 'page', at: new Date().toISOString() }],
    word_count: words || null,
    reading_time_minutes: words > 0 ? Math.max(1, Math.round(words / 230)) : null,
  };
}

/**
 * Manual text capture (selection / typed input). No DOM element.
 */
export function extractManual(text: string, url?: string): Extracted {
  const ts = new Date().toISOString();
  return {
    node_type: 'text',
    title: null,
    description: text.slice(0, 200),
    author: null,
    content: text.slice(0, MAX_CONTENT_CHARS),
    media_url: url ?? null,
    media_thumbnail: null,
    lang: null,
    site_name: null,
    published_at: null,
    keywords: [],
    actions: [{ kind: 'save', value: 'manual', at: ts }],
    source_extracted_at: ts,
    extraction_method: 'manual',
  };
}

/**
 * Produce a concise text body to send as `content` on the API.
 * The full Extracted JSON is also attached as metadata.extracted.
 */
export function contentFromExtracted(e: Extracted): string {
  const parts: string[] = [];
  if (e.title) parts.push(e.title);
  if (e.author) parts.push(`— ${e.author}`);
  if (e.description && e.description !== e.title) parts.push(e.description);
  if (e.content && !parts.join(' ').includes(e.content.slice(0, 80))) {
    parts.push(e.content);
  }
  if (e.media_url && (e.node_type === 'image' || e.node_type === 'video' || e.node_type === 'link')) {
    parts.push(`[${e.node_type}] ${e.media_url}`);
  }
  const joined = parts.filter(Boolean).join('\n\n').trim();
  return joined.slice(0, MAX_CONTENT_CHARS) || (e.title ?? e.media_url ?? '(empty)');
}
