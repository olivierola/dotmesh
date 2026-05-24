/**
 * Minimal TipTap-based markdown-ish editor.
 *
 * - Bubble-free, no toolbar — uses markdown shortcuts (**, ##, -, etc.)
 *   provided by StarterKit.
 * - [[wiki-link]] text is rendered with a custom span style so the user
 *   sees their links visually.
 * - Slash menu is intentionally left out for v1 (keeps bundle + bugs down);
 *   users can still apply formatting via markdown shortcuts.
 *
 * `onChange` is called debounced with both the JSON content (for server
 * persistence — we serialize back to markdown-ish text) and the rendered
 * HTML (cached in metadata.note_html for faster previews).
 */

import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import { useEffect, useRef } from 'react';

interface Props {
  initialContent: string;
  onChange: (markdown: string, html: string) => void;
  placeholder?: string;
}

/**
 * Very small TipTap-doc → markdown serializer. Covers the subset that
 * StarterKit produces (headings, paragraphs, bold/italic, lists, code,
 * blockquote, hr, hard breaks). Good enough for round-tripping.
 */
function docToMarkdown(json: unknown): string {
  const root = json as { type?: string; content?: unknown[] };
  if (!root?.content) return '';
  const out: string[] = [];
  for (const block of root.content as Array<Record<string, unknown>>) {
    out.push(renderBlock(block));
  }
  return out.join('\n\n').trim();
}

function renderBlock(node: Record<string, unknown>): string {
  const type = node.type as string;
  const attrs = (node.attrs as Record<string, unknown>) ?? {};
  const inline = renderInline((node.content as unknown[]) ?? []);
  switch (type) {
    case 'heading': {
      const lvl = Math.min(Math.max(Number(attrs.level ?? 1), 1), 6);
      return `${'#'.repeat(lvl)} ${inline}`;
    }
    case 'paragraph':
      return inline;
    case 'blockquote':
      return inline
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'codeBlock':
      return '```\n' + inline + '\n```';
    case 'bulletList':
      return ((node.content as unknown[]) ?? [])
        .map((li) => `- ${renderInline(((li as Record<string, unknown>).content as unknown[]) ?? [])}`)
        .join('\n');
    case 'orderedList':
      return ((node.content as unknown[]) ?? [])
        .map(
          (li, i) =>
            `${i + 1}. ${renderInline(((li as Record<string, unknown>).content as unknown[]) ?? [])}`,
        )
        .join('\n');
    case 'horizontalRule':
      return '---';
    default:
      return inline;
  }
}

function renderInline(nodes: unknown[]): string {
  return nodes
    .map((n) => {
      const node = n as Record<string, unknown>;
      if (node.type === 'paragraph') return renderInline((node.content as unknown[]) ?? []);
      if (node.type === 'hardBreak') return '\n';
      if (node.type !== 'text') return '';
      let txt = String(node.text ?? '');
      const marks = (node.marks as Array<Record<string, unknown>>) ?? [];
      for (const m of marks) {
        if (m.type === 'bold') txt = `**${txt}**`;
        else if (m.type === 'italic') txt = `*${txt}*`;
        else if (m.type === 'code') txt = `\`${txt}\``;
        else if (m.type === 'link') {
          const href = (m.attrs as Record<string, unknown>)?.href ?? '';
          txt = `[${txt}](${href})`;
        }
      }
      return txt;
    })
    .join('');
}

export default function NoteEditor({ initialContent, onChange, placeholder }: Props) {
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: {},
      }),
      Placeholder.configure({
        placeholder: placeholder ?? "Start writing… use [[note title]] to link other notes",
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
      }),
    ],
    content: markdownToHtml(initialContent),
    editorProps: {
      attributes: {
        class:
          'tiptap-note prose prose-invert max-w-none focus:outline-none min-h-[60vh] text-[15px] leading-relaxed',
      },
    },
    onUpdate: ({ editor }) => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        const md = docToMarkdown(editor.getJSON());
        const html = editor.getHTML();
        onChange(md, html);
      }, 600);
    },
  });

  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  return (
    <div className="note-editor">
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
      <style>{`
        .tiptap-note p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: #525252;
          pointer-events: none;
          height: 0;
        }
        .tiptap-note h1 { font-size: 1.6rem; font-weight: 600; margin-top: 1rem; }
        .tiptap-note h2 { font-size: 1.3rem; font-weight: 600; margin-top: 1rem; }
        .tiptap-note h3 { font-size: 1.1rem; font-weight: 600; margin-top: .75rem; }
        .tiptap-note p { margin: .5rem 0; }
        .tiptap-note ul, .tiptap-note ol { margin: .5rem 0 .5rem 1.25rem; }
        .tiptap-note li { margin: .25rem 0; }
        .tiptap-note blockquote {
          border-left: 3px solid #f5b301;
          padding-left: 0.75rem;
          color: #a3a3a3;
          margin: .75rem 0;
        }
        .tiptap-note code {
          background: #1f1f1f;
          padding: 1px 5px;
          border-radius: 4px;
          font-size: 0.9em;
        }
        .tiptap-note pre {
          background: #0a0a0a;
          border: 1px solid #1f1f1f;
          padding: .75rem;
          border-radius: 6px;
          overflow-x: auto;
        }
        .tiptap-note a { color: #f5b301; text-decoration: underline; }
      `}</style>
    </div>
  );
}

/* ------------------------------------------------------------- */
/*                          Toolbar                               */
/* ------------------------------------------------------------- */

function Toolbar({ editor }: { editor: Editor }) {
  const insertWikiLink = () => {
    const title = window.prompt('Link to which note? (type the exact title)');
    if (!title?.trim()) return;
    editor.chain().focus().insertContent(`[[${title.trim()}]] `).run();
  };

  const promptLink = () => {
    const url = window.prompt('URL');
    if (!url?.trim()) return;
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };

  return (
    <div className="mb-3 flex flex-wrap items-center gap-0.5 rounded-md border border-neutral-800 bg-neutral-900/60 p-1 text-xs">
      <ToolGroup>
        <ToolBtn
          active={editor.isActive('heading', { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          title="Heading 1"
        >
          H1
        </ToolBtn>
        <ToolBtn
          active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title="Heading 2"
        >
          H2
        </ToolBtn>
        <ToolBtn
          active={editor.isActive('heading', { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          title="Heading 3"
        >
          H3
        </ToolBtn>
        <ToolBtn
          active={editor.isActive('paragraph') && !editor.isActive('heading')}
          onClick={() => editor.chain().focus().setParagraph().run()}
          title="Paragraph"
        >
          ¶
        </ToolBtn>
      </ToolGroup>

      <Divider />

      <ToolGroup>
        <ToolBtn
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold (Ctrl+B)"
        >
          <strong>B</strong>
        </ToolBtn>
        <ToolBtn
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic (Ctrl+I)"
        >
          <em>I</em>
        </ToolBtn>
        <ToolBtn
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title="Strikethrough"
        >
          <s>S</s>
        </ToolBtn>
        <ToolBtn
          active={editor.isActive('code')}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="Inline code"
        >
          {'</>'}
        </ToolBtn>
      </ToolGroup>

      <Divider />

      <ToolGroup>
        <ToolBtn
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="Bullet list"
        >
          •
        </ToolBtn>
        <ToolBtn
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="Numbered list"
        >
          1.
        </ToolBtn>
        <ToolBtn
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          title="Quote"
        >
          ❝
        </ToolBtn>
        <ToolBtn
          active={editor.isActive('codeBlock')}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          title="Code block"
        >
          {'{ }'}
        </ToolBtn>
      </ToolGroup>

      <Divider />

      <ToolGroup>
        <ToolBtn onClick={promptLink} title="Insert URL link" active={editor.isActive('link')}>
          🔗
        </ToolBtn>
        <ToolBtn onClick={insertWikiLink} title="Link another note ([[title]])">
          [[ ]]
        </ToolBtn>
        <ToolBtn
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title="Divider"
        >
          —
        </ToolBtn>
      </ToolGroup>

      <Divider />

      <ToolGroup>
        <ToolBtn
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
          title="Undo"
        >
          ↶
        </ToolBtn>
        <ToolBtn
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
          title="Redo"
        >
          ↷
        </ToolBtn>
      </ToolGroup>
    </div>
  );
}

function ToolGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

function Divider() {
  return <div className="mx-1 h-5 w-px bg-neutral-800" />;
}

function ToolBtn({
  children,
  onClick,
  title,
  active,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`grid h-7 min-w-[28px] place-items-center rounded px-1.5 text-xs transition-colors disabled:opacity-40 ${
        active
          ? 'bg-accent/20 text-accent'
          : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Naive markdown-to-html — TipTap will reparse cleanly into its schema.
 * We only handle the same subset that docToMarkdown emits, since this is
 * meant for round-tripping notes the user authored in this same editor.
 */
function markdownToHtml(md: string): string {
  if (!md) return '';
  const lines = md.split('\n');
  const out: string[] = [];
  let inList: 'ul' | 'ol' | null = null;
  let inPre = false;

  const closeList = () => {
    if (inList) {
      out.push(inList === 'ul' ? '</ul>' : '</ol>');
      inList = null;
    }
  };

  for (const raw of lines) {
    const line = raw;
    if (inPre) {
      if (line.trim() === '```') {
        out.push('</code></pre>');
        inPre = false;
      } else {
        out.push(escapeHtml(line));
      }
      continue;
    }
    if (line.trim().startsWith('```')) {
      closeList();
      inPre = true;
      out.push('<pre><code>');
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<h${heading[1]!.length}>${inlineMd(heading[2]!)}</h${heading[1]!.length}>`);
      continue;
    }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) {
      if (inList !== 'ul') {
        closeList();
        out.push('<ul>');
        inList = 'ul';
      }
      out.push(`<li>${inlineMd(ul[1]!)}</li>`);
      continue;
    }
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      if (inList !== 'ol') {
        closeList();
        out.push('<ol>');
        inList = 'ol';
      }
      out.push(`<li>${inlineMd(ol[1]!)}</li>`);
      continue;
    }
    const bq = line.match(/^>\s+(.*)$/);
    if (bq) {
      closeList();
      out.push(`<blockquote>${inlineMd(bq[1]!)}</blockquote>`);
      continue;
    }
    if (line.trim() === '---') {
      closeList();
      out.push('<hr />');
      continue;
    }
    if (line.trim() === '') {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

function inlineMd(s: string): string {
  let r = escapeHtml(s);
  r = r.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  r = r.replace(/\*(.+?)\*/g, '<em>$1</em>');
  r = r.replace(/`([^`]+?)`/g, '<code>$1</code>');
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return r;
}
