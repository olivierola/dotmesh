/**
 * Read-only modal that shows the contents Mesh captured for a single
 * memory. Reused across the Timeline, the Collection detail page, and
 * the Assistant's citation badges.
 *
 * The shape we accept is intentionally loose: callers pass whatever
 * subset of fields they already have. The component picks the best
 * available title / body / image and the URL is offered as a small
 * link at the bottom (because most source URLs we store are feed-level,
 * not the canonical post — so we don't want them to be the primary
 * action anymore).
 */

import { useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { displayForNode, cleanBodyText } from '@/lib/node-display';
import type { MockNode } from '@/lib/mock';

export interface PreviewInput {
  id: string;
  title?: string | null;
  /** Full text body (Markdown or plain). Will be reflowed for readability. */
  body?: string | null;
  /** Optional separate summary; shown above the body if both differ. */
  summary?: string | null;
  source?: string | null;
  source_url?: string | null;
  source_app?: string | null;
  created_at?: string | null;
  node_type?: string | null;
  tags?: string[];
  /** Whole metadata bag so we can pull extracted.* fields if present. */
  metadata?: Record<string, unknown>;
  /** Citation index when opened from the assistant; null for nav opens. */
  citationIndex?: number | null;
}

interface Props {
  input: PreviewInput;
  onClose: () => void;
}

/**
 * Walks a body string, finds bare URLs (http/https) and renders each as a
 * compact pill (favicon + host + short path) instead of the noisy raw URL.
 * Everything outside a URL stays as-is so formatting / newlines survive.
 */
function BodyWithLinkBadges({ text }: { text: string }) {
  // Stops at whitespace, closing bracket/paren that usually wrap URLs in
  // markdown / prose, and common trailing punctuation.
  const URL_RE = /https?:\/\/[^\s<>"'\]\)]+/g;
  const parts: Array<{ kind: 'text'; value: string } | { kind: 'url'; value: string }> = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text))) {
    if (m.index > cursor) parts.push({ kind: 'text', value: text.slice(cursor, m.index) });
    // Trim trailing punctuation that's rarely part of the URL.
    let url = m[0];
    while (url.length > 1 && /[.,;:!?)]$/.test(url)) {
      url = url.slice(0, -1);
    }
    parts.push({ kind: 'url', value: url });
    cursor = m.index + url.length;
  }
  if (cursor < text.length) parts.push({ kind: 'text', value: text.slice(cursor) });

  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'text' ? <span key={i}>{p.value}</span> : <UrlBadge key={i} url={p.value} />,
      )}
    </>
  );
}

function UrlBadge({ url }: { url: string }) {
  let host: string | null = null;
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '');
    path = u.pathname + (u.search ? '?…' : '');
    if (path.length > 28) path = path.slice(0, 26) + '…';
    if (path === '/') path = '';
  } catch {
    /* leave host null */
  }
  const favicon = host
    ? `https://www.google.com/s2/favicons?domain=${host}&sz=32`
    : null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={url}
      className="mx-0.5 inline-flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-900/70 px-2 py-0.5 align-baseline text-[12px] text-neutral-200 transition-colors hover:border-accent hover:text-accent"
    >
      {favicon && (
        <img
          src={favicon}
          alt=""
          className="h-3.5 w-3.5 rounded-sm"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      )}
      <span className="font-medium">{host ?? 'link'}</span>
      {path && <span className="max-w-[160px] truncate text-[11px] text-neutral-500">{path}</span>}
      <span className="text-[10px] text-neutral-500">↗</span>
    </a>
  );
}

export default function MemoryPreviewModal({ input, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Reuse the same display logic the Timeline cards use so titles /
  // bodies / favicons feel consistent across the app.
  const asMockNode: MockNode = {
    id: input.id,
    user_id: '',
    source: input.source ?? '',
    source_url: input.source_url ?? undefined,
    source_app: input.source_app ?? undefined,
    content: input.body ?? input.summary ?? '',
    summary: input.summary ?? null,
    embedding_model: null,
    entities: [],
    tags: input.tags ?? [],
    user_tags: [],
    score: null,
    sensitivity: null,
    acl_agents: [],
    ttl_at: null,
    pinned: false,
    edited_summary: null,
    fingerprint: '',
    node_type: input.node_type ?? null,
    metadata: (input.metadata ?? {}) as MockNode['metadata'],
    created_at: input.created_at ?? new Date().toISOString(),
    updated_at: input.created_at ?? new Date().toISOString(),
  } as unknown as MockNode;

  const display = displayForNode(asMockNode);
  const title = input.title?.trim() || display.title;
  const bodyText = cleanBodyText(input.body ?? input.summary ?? '');
  const extracted =
    (input.metadata?.extracted as
      | {
          title?: string | null;
          author?: string | null;
          published_at?: string | null;
          site_name?: string | null;
          description?: string | null;
          media_url?: string | null;
          reading_time_minutes?: number | null;
          keywords?: string[];
        }
      | undefined) ?? {};

  const mediaUrl =
    extracted.media_url ??
    (input.metadata?.mediaUrl as string | undefined) ??
    null;
  const elementType =
    (input.metadata?.elementType as string | undefined) ??
    input.node_type ??
    null;
  const isImage = elementType === 'image' || input.node_type === 'image';
  const isVideo = elementType === 'video' || input.node_type === 'video';

  let host: string | null = null;
  if (input.source_url) {
    try {
      host = new URL(input.source_url).hostname;
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-3 border-b border-neutral-900 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            {display.faviconUrl ? (
              <img
                src={display.faviconUrl}
                alt=""
                className="h-5 w-5 shrink-0 rounded"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <span className="text-base">📝</span>
            )}
            {input.citationIndex != null && (
              <span
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent/15 text-[10px] font-semibold text-accent"
                title="Citation index"
              >
                {input.citationIndex}
              </span>
            )}
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-neutral-100" title={title}>
                {title}
              </h3>
              {display.subtitle && (
                <p className="truncate text-[11px] text-neutral-500">
                  {display.subtitle}
                  {input.created_at && (
                    <>
                      {' · '}
                      {formatDistanceToNow(new Date(input.created_at), { addSuffix: true })}
                    </>
                  )}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-neutral-500 hover:text-neutral-200"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto px-5 py-5">
          {/* Media */}
          {isImage && mediaUrl && (
            <div className="mb-4 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
              <img
                src={mediaUrl}
                alt={title}
                className="block h-auto max-h-96 w-full object-contain"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
          )}
          {isVideo && mediaUrl && (
            <video
              src={mediaUrl}
              controls
              preload="metadata"
              className="mb-4 block h-auto max-h-96 w-full rounded-lg border border-neutral-800"
            />
          )}

          {extracted.description && extracted.description !== bodyText && (
            <p className="mb-4 text-[14px] leading-relaxed text-neutral-300">
              {extracted.description}
            </p>
          )}

          {bodyText ? (
            <div className="whitespace-pre-line break-words text-[14px] leading-relaxed text-neutral-200">
              <BodyWithLinkBadges text={bodyText} />
            </div>
          ) : (
            <p className="text-sm italic text-neutral-500">No body content captured.</p>
          )}

          {/* Metadata strip */}
          {(extracted.author ||
            extracted.published_at ||
            extracted.reading_time_minutes != null ||
            (extracted.keywords && extracted.keywords.length > 0)) && (
            <div className="mt-5 flex flex-wrap gap-x-3 gap-y-1.5 border-t border-neutral-900 pt-4 text-[11px] text-neutral-500">
              {extracted.author && <span>✍ {extracted.author}</span>}
              {extracted.published_at && (
                <span>📅 {extracted.published_at.slice(0, 10)}</span>
              )}
              {extracted.reading_time_minutes != null && (
                <span>⏱ ~{extracted.reading_time_minutes} min read</span>
              )}
              {extracted.keywords && extracted.keywords.length > 0 && (
                <span className="truncate">
                  🔖 {extracted.keywords.slice(0, 4).join(', ')}
                </span>
              )}
            </div>
          )}

          {(input.tags?.length ?? 0) > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {(input.tags ?? []).map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-neutral-800 bg-neutral-900/60 px-2 py-0.5 text-[10px] text-neutral-400"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Footer: source link */}
        {input.source_url && (
          <footer className="flex items-center justify-between gap-3 border-t border-neutral-900 px-5 py-3 text-[11px] text-neutral-500">
            <span className="truncate">
              Captured from{' '}
              <span className="font-medium text-neutral-300">{host ?? input.source}</span>
            </span>
            <a
              href={input.source_url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-neutral-400 transition-colors hover:border-accent hover:text-accent"
              title={input.source_url}
            >
              open original ↗
            </a>
          </footer>
        )}
      </div>
    </div>
  );
}
