/**
 * Translate a natural-language collection description into a structured filter.
 *
 * Example inputs and expected outputs:
 *
 *   "Everything from Slack and from my AI chats with Claude or ChatGPT"
 *   → { sources: ["connector:slack"], domains: ["claude.ai","chatgpt.com"] }
 *
 *   "Only my health and medical stuff"
 *   → { tags: ["health","medical"], keywords: ["doctor","appointment","health"] }
 *
 *   "Work-related memories, exclude anything personal"
 *   → { tags: ["work"], exclude_tags: ["personal"] }
 *
 *   "Articles about AI agents I read on Hacker News or arxiv"
 *   → { domains: ["news.ycombinator.com","arxiv.org"], keywords: ["agent","AI"] }
 */

import { groqChat } from './ai.ts';

export interface CollectionFilter {
  sources?: string[];
  tags?: string[];
  domains?: string[];
  keywords?: string[];
  exclude_tags?: string[];
  exclude_domains?: string[];
}

const VALID_SOURCES = [
  'extension',
  'manual',
  'mcp',
  'connector:gmail',
  'connector:gcal',
  'connector:slack',
  'connector:notion',
  'connector:linear',
  'connector:github',
  'connector:figma',
  'connector:gdocs',
];

/** Sanitize an LLM JSON output into a safe filter object. */
function sanitize(raw: unknown): CollectionFilter {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const arr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const out = v
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 100);
    return out.length > 0 ? out.slice(0, 20) : undefined;
  };
  const filter: CollectionFilter = {};
  const sources = arr(r.sources)?.filter((s) => VALID_SOURCES.includes(s));
  if (sources?.length) filter.sources = sources;
  const tags = arr(r.tags);
  if (tags?.length) filter.tags = tags.map((t) => t.toLowerCase());
  const domains = arr(r.domains);
  if (domains?.length) filter.domains = domains.map((d) => d.toLowerCase());
  const keywords = arr(r.keywords);
  if (keywords?.length) filter.keywords = keywords.map((k) => k.toLowerCase()).slice(0, 12);
  const excl_tags = arr(r.exclude_tags);
  if (excl_tags?.length) filter.exclude_tags = excl_tags.map((t) => t.toLowerCase());
  const excl_domains = arr(r.exclude_domains);
  if (excl_domains?.length) filter.exclude_domains = excl_domains.map((d) => d.toLowerCase());
  return filter;
}

export async function describeToFilter(prompt: string): Promise<CollectionFilter> {
  const result = await groqChat({
    model: 'llama-3.1-8b-instant',
    systemPrompt:
      'You translate a user-provided collection description into a structured JSON filter that can be applied to their captured memory nodes. Output STRICT JSON ONLY, no markdown.',
    userPrompt: `Available source values (use literally):
${VALID_SOURCES.map((s) => `  - ${s}`).join('\n')}

Translate the following description into this JSON schema:

{
  "sources":         string[],   // pick from the valid list above (only what user implied)
  "tags":            string[],   // free tags inferred from the description (lowercase)
  "domains":         string[],   // hostnames like "claude.ai", "github.com" — no scheme, no path
  "keywords":        string[],   // up to 6 keywords that appear in nodes matching the description
  "exclude_tags":    string[],   // anything the user wants EXCLUDED
  "exclude_domains": string[]    // domains to exclude
}

Rules:
- Use only the keys above; omit groups that are empty.
- Stay literal. Don't infer too aggressively. If the description says "anything about work", DON'T add unrelated keywords.
- Source aliases: "Slack" → connector:slack, "Gmail/email" → connector:gmail, "Calendar" → connector:gcal, "Notion" → connector:notion, "browser/web/article" → extension, "manually added" → manual.
- AI chat domains map to: claude.ai (Claude), chatgpt.com (ChatGPT), gemini.google.com (Gemini), www.perplexity.ai (Perplexity).
- Return JSON ONLY.

Description: """${prompt.slice(0, 800)}"""`,
    jsonMode: true,
    maxTokens: 400,
    feature: 'collections-classifier',
  });

  if (!result) return {};
  try {
    return sanitize(JSON.parse(result));
  } catch {
    return {};
  }
}
