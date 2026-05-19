/**
 * Server-side completion of the canonical `extracted` JSON.
 *
 * The extension produces an initial `Extracted` object from page DOM
 * heuristics. Some fields may be null (e.g. author missing, no OG meta).
 * This module calls a small LLM to fill the gaps when the input text is
 * substantial enough to warrant it. Cheap, ~200ms with Groq llama-8b.
 *
 * Contract: never *overwrite* fields that the heuristic extractor already set.
 * The LLM only proposes values for currently-null fields.
 */

import { groqChat } from './ai.ts';

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
  kind: string;
  value?: string | null;
  at: string;
}

export interface Extracted {
  node_type: NodeType;
  title: string | null;
  description: string | null;
  author: string | null;
  content: string | null;
  media_url: string | null;
  media_thumbnail: string | null;
  lang: string | null;
  site_name: string | null;
  published_at: string | null;
  keywords: string[];
  actions: ExtractedAction[];
  source_extracted_at: string;
  extraction_method: 'heuristic' | 'llm' | 'mixed' | 'manual';
}

const VALID_TYPES: NodeType[] = [
  'text', 'image', 'video', 'link', 'code', 'quote', 'page', 'action',
];

/**
 * Return a fresh Extracted built from the row stored in DB, falling back to
 * a minimal default when nothing was attached at capture time. Used both for
 * brand-new rows (extension capture) and for re-processing legacy rows.
 */
export function readExtracted(metadata: unknown): Extracted | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as Record<string, unknown>;
  const e = m.extracted;
  if (!e || typeof e !== 'object') return null;
  const r = e as Record<string, unknown>;
  const node_type =
    typeof r.node_type === 'string' && (VALID_TYPES as string[]).includes(r.node_type)
      ? (r.node_type as NodeType)
      : 'text';
  return {
    node_type,
    title: typeof r.title === 'string' ? r.title : null,
    description: typeof r.description === 'string' ? r.description : null,
    author: typeof r.author === 'string' ? r.author : null,
    content: typeof r.content === 'string' ? r.content : null,
    media_url: typeof r.media_url === 'string' ? r.media_url : null,
    media_thumbnail: typeof r.media_thumbnail === 'string' ? r.media_thumbnail : null,
    lang: typeof r.lang === 'string' ? r.lang : null,
    site_name: typeof r.site_name === 'string' ? r.site_name : null,
    published_at: typeof r.published_at === 'string' ? r.published_at : null,
    keywords: Array.isArray(r.keywords)
      ? r.keywords.filter((k): k is string => typeof k === 'string')
      : [],
    actions: Array.isArray(r.actions)
      ? r.actions.filter((a): a is ExtractedAction =>
          !!a && typeof a === 'object' && typeof (a as ExtractedAction).kind === 'string',
        )
      : [],
    source_extracted_at:
      typeof r.source_extracted_at === 'string'
        ? r.source_extracted_at
        : new Date().toISOString(),
    extraction_method:
      r.extraction_method === 'llm' ||
      r.extraction_method === 'mixed' ||
      r.extraction_method === 'manual'
        ? r.extraction_method
        : 'heuristic',
  };
}

/** Build a minimal Extracted from raw content when none exists yet. */
export function fallbackExtractedFromContent(
  content: string,
  source: string,
  source_url: string | null,
  source_app: string | null,
): Extracted {
  return {
    node_type: 'text',
    title: null,
    description: null,
    author: null,
    content: content.slice(0, 8000),
    media_url: source_url,
    media_thumbnail: null,
    lang: null,
    site_name: source_app,
    published_at: null,
    keywords: [],
    actions: [{ kind: 'save', value: source, at: new Date().toISOString() }],
    source_extracted_at: new Date().toISOString(),
    extraction_method: 'heuristic',
  };
}

/** Which fields are worth asking the LLM to fill in? */
function missingFields(e: Extracted): string[] {
  const missing: string[] = [];
  if (!e.title) missing.push('title');
  if (!e.description) missing.push('description');
  if (!e.author) missing.push('author');
  if (e.keywords.length === 0) missing.push('keywords');
  return missing;
}

/**
 * Run a small LLM call to fill in the null fields of `extracted`. Returns the
 * merged Extracted (or the input untouched if the LLM is unavailable / errors).
 */
export async function completeExtractedWithLLM(
  base: Extracted,
  rawContent: string,
  source_url: string | null,
): Promise<Extracted> {
  const missing = missingFields(base);
  if (missing.length === 0) return base;

  // If we have almost no text to reason from, skip the LLM.
  const haystack = [base.title, base.description, base.content, rawContent]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 4000);
  if (haystack.trim().length < 60) return base;

  const sys =
    'You extract structured metadata from captured web content and reply with strict JSON only. ' +
    'No prose, no markdown. Use null when a value cannot be reliably inferred.';

  const user = `From the captured content below, fill in the following missing fields:
${missing.map((m) => `  - ${m}`).join('\n')}

Return JSON in this exact shape (omit fields you cannot fill):
{
  "title":       string | null,   // 1 short sentence headline, no quotes
  "description": string | null,   // 1-2 sentence summary
  "author":      string | null,   // person or org name
  "keywords":    string[]         // up to 8 short topic tags (lowercase)
}

Constraints:
- Do NOT invent an author if none is mentioned — return null.
- Keep "description" under 280 characters.
- Keywords must be topical (e.g. "machine learning", "design") — not generic ("article", "blog").
- Match the language of the source.

Source URL: ${source_url ?? '(none)'}
Captured site_name: ${base.site_name ?? '(none)'}

Content:
"""
${haystack}
"""`;

  const result = await groqChat({
    model: 'llama-3.1-8b-instant',
    systemPrompt: sys,
    userPrompt: user,
    jsonMode: true,
    maxTokens: 400,
    feature: 'extracted-completion',
  });

  if (!result) return base;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result) as Record<string, unknown>;
  } catch {
    return base;
  }

  const merged: Extracted = { ...base };
  if (!merged.title && typeof parsed.title === 'string') {
    merged.title = parsed.title.trim().slice(0, 240) || null;
  }
  if (!merged.description && typeof parsed.description === 'string') {
    merged.description = parsed.description.trim().slice(0, 600) || null;
  }
  if (!merged.author && typeof parsed.author === 'string') {
    const a = parsed.author.trim();
    if (a.length > 0 && a.length <= 120) merged.author = a;
  }
  if (merged.keywords.length === 0 && Array.isArray(parsed.keywords)) {
    merged.keywords = parsed.keywords
      .filter((k): k is string => typeof k === 'string')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0 && k.length <= 50)
      .slice(0, 8);
  }
  merged.extraction_method = base.extraction_method === 'manual' ? 'mixed' : 'llm';
  return merged;
}
