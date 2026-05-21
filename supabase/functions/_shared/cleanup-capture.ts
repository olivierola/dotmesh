/**
 * Pre-insert capture cleanup.
 *
 * The extension sends a lot of noisy text: cookie banners, nav menus,
 * footer copyright, repeated CTAs, scroll-glue ("read more / 12 min read"),
 * and so on. Storing that raw means every embedding, every NER pass, every
 * search hit gets polluted by the noise.
 *
 * This helper makes ONE synchronous Groq call before insert and replaces
 * the user-supplied `content` with a cleaner version + a short `summary`.
 *
 * Design choices:
 *   - Synchronous on the /nodes path: the user-perceived latency budget is
 *     the extension's queue flush, not the keystroke; ~600ms is fine.
 *   - Falls back to the raw input if the LLM is unavailable so the capture
 *     pipeline never blocks on cleanup errors.
 *   - Hard length caps so a runaway model output can't blow up the schema.
 */

import { groqChat } from './ai.ts';

const MIN_LEN_FOR_CLEANUP = 200;
const MAX_INPUT_CHARS = 6000;
const MAX_CLEAN_CHARS = 4000;
const MAX_SUMMARY_CHARS = 400;

export interface CleanupResult {
  /** Cleaned, denoised text — what we store in `context_nodes.content`. */
  content: string;
  /** Short 1-2 sentence summary, stored in `context_nodes.summary`. */
  summary: string | null;
  /** True when the LLM actually ran; false when we returned the raw text. */
  llm_applied: boolean;
}

/**
 * Clean and summarise a capture. Safe to call on any string — short ones
 * are returned verbatim with no LLM call.
 */
export async function cleanupCapture(opts: {
  rawContent: string;
  source: string;
  sourceUrl?: string | null;
  sourceApp?: string | null;
  pageTitle?: string | null;
  captureType?: string | null;
  elementType?: string | null;
}): Promise<CleanupResult> {
  const raw = (opts.rawContent ?? '').trim();
  if (raw.length < MIN_LEN_FOR_CLEANUP) {
    return { content: raw, summary: null, llm_applied: false };
  }

  // Plain-text path for code captures — formatting matters, never reflow.
  if (opts.elementType === 'code') {
    return { content: raw.slice(0, MAX_CLEAN_CHARS), summary: null, llm_applied: false };
  }

  const sys =
    'You denoise captured web content and return STRICT JSON only. ' +
    'You preserve facts and the user-visible information, but remove navigation menus, ' +
    'cookie banners, footer copyright, share/CTA buttons, repeated boilerplate, ' +
    'and any text that is not part of the actual content being captured. ' +
    'You DO NOT summarise the content unless explicitly asked; you only clean it.';

  const userPrompt = `Clean the captured text below.

Source: ${opts.source}${opts.sourceApp ? ` (${opts.sourceApp})` : ''}
URL: ${opts.sourceUrl ?? '(none)'}
Page title: ${opts.pageTitle ?? '(none)'}
Capture type: ${opts.captureType ?? '(none)'}
Element: ${opts.elementType ?? '(none)'}

Return JSON in this exact shape:
{
  "content": string,   // cleaned text, max ${MAX_CLEAN_CHARS} chars, preserves the real information
  "summary": string    // 1-2 short sentences describing what was captured, max ${MAX_SUMMARY_CHARS} chars
}

Rules:
- Keep the user-visible information intact (numbers, names, code, dates).
- Drop nav, ads, cookie text, "subscribe to our newsletter", footer, share buttons.
- Drop UI labels that aren't content ("Reply", "Like", "Share", "Read more").
- Match the source language; never translate.
- If nothing useful remains after cleaning, return "" for content.

Raw text:
"""
${raw.slice(0, MAX_INPUT_CHARS)}
"""`;

  const result = await groqChat({
    model: 'llama-3.1-8b-instant',
    systemPrompt: sys,
    userPrompt,
    jsonMode: true,
    maxTokens: 1200,
    feature: 'capture-cleanup',
  });

  if (!result) {
    // LLM unavailable — fall back to the raw text so capture still succeeds.
    return { content: raw.slice(0, MAX_CLEAN_CHARS), summary: null, llm_applied: false };
  }

  try {
    const parsed = JSON.parse(result) as { content?: unknown; summary?: unknown };
    const cleaned =
      typeof parsed.content === 'string'
        ? parsed.content.trim().slice(0, MAX_CLEAN_CHARS)
        : '';
    const summary =
      typeof parsed.summary === 'string'
        ? parsed.summary.trim().slice(0, MAX_SUMMARY_CHARS)
        : null;
    // If the model returned an empty cleaned content, prefer the raw (we
    // don't want to lose the capture entirely on a model hiccup).
    return {
      content: cleaned.length >= 20 ? cleaned : raw.slice(0, MAX_CLEAN_CHARS),
      summary: summary && summary.length >= 5 ? summary : null,
      llm_applied: cleaned.length >= 20,
    };
  } catch {
    return { content: raw.slice(0, MAX_CLEAN_CHARS), summary: null, llm_applied: false };
  }
}
