import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, ArrowUp, X, FileText, Loader2, Archive } from 'lucide-react';

/* --- Types --- */
export interface AttachedFile {
  id: string;
  file: File;
  type: string;
  preview: string | null;
  uploadStatus: 'pending' | 'uploading' | 'complete';
}

export interface PastedSnippet {
  id: string;
  content: string;
  timestamp: Date;
}

export interface ChatInputPayload {
  message: string;
  files: AttachedFile[];
  pastedContent: PastedSnippet[];
  isThinkingEnabled: boolean;
}

interface ChatInputProps {
  onSendMessage: (payload: ChatInputPayload) => void;
  /** Disable the send button while a stream is in progress. */
  disabled?: boolean;
  placeholder?: string;
  /** Show the "extended thinking" toggle (default true). */
  thinkingToggle?: boolean;
}

/* --- Utils --- */
const formatFileSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const newId = () => Math.random().toString(36).slice(2, 11);

/* --- File preview card --- */
const FilePreviewCard: React.FC<{
  file: AttachedFile;
  onRemove: (id: string) => void;
}> = ({ file, onRemove }) => {
  const isImage = file.type.startsWith('image/') && file.preview;
  return (
    <div className="relative group flex-shrink-0 w-24 h-24 rounded-xl overflow-hidden border border-bg-300 bg-bg-200 animate-fade-in transition-all hover:border-text-400">
      {isImage ? (
        <div className="w-full h-full relative">
          <img src={file.preview!} alt={file.file.name} className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/20 group-hover:bg-black/0 transition-colors" />
        </div>
      ) : (
        <div className="w-full h-full p-3 flex flex-col justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-bg-300 rounded">
              <FileText className="w-4 h-4 text-text-300" />
            </div>
            <span className="text-[10px] font-medium text-text-400 uppercase tracking-wider truncate">
              {file.file.name.split('.').pop()}
            </span>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs font-medium text-text-200 truncate" title={file.file.name}>
              {file.file.name}
            </p>
            <p className="text-[10px] text-text-500">{formatFileSize(file.file.size)}</p>
          </div>
        </div>
      )}
      <button
        onClick={() => onRemove(file.id)}
        className="absolute top-1 right-1 p-1 bg-black/50 hover:bg-black/70 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label="Remove file"
      >
        <X className="w-3 h-3" />
      </button>
      {file.uploadStatus === 'uploading' && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
          <Loader2 className="w-5 h-5 text-white animate-spin" />
        </div>
      )}
    </div>
  );
};

/* --- Pasted content card --- */
const PastedContentCard: React.FC<{
  content: PastedSnippet;
  onRemove: (id: string) => void;
}> = ({ content, onRemove }) => (
  <div className="relative group flex-shrink-0 w-28 h-28 rounded-2xl overflow-hidden border border-bg-300 bg-bg-100 animate-fade-in p-3 flex flex-col justify-between">
    <div className="overflow-hidden w-full">
      <p className="text-[10px] text-text-400 leading-[1.4] font-mono break-words whitespace-pre-wrap line-clamp-5 select-none">
        {content.content}
      </p>
    </div>
    <div className="flex items-center justify-between w-full mt-2">
      <div className="inline-flex items-center justify-center px-1.5 py-[2px] rounded border border-bg-300 bg-bg-200">
        <span className="text-[9px] font-bold text-text-400 uppercase tracking-wider">PASTED</span>
      </div>
    </div>
    <button
      onClick={() => onRemove(content.id)}
      className="absolute top-2 right-2 p-[3px] bg-bg-200 border border-bg-300 rounded-full text-text-400 hover:text-text-200 transition-colors opacity-0 group-hover:opacity-100"
      aria-label="Remove snippet"
    >
      <X className="w-2 h-2" />
    </button>
  </div>
);

/* --- Main component --- */
export const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  disabled = false,
  placeholder = 'How can I help you today?',
  thinkingToggle = true,
}) => {
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [pastedContent, setPastedContent] = useState<PastedSnippet[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isThinkingEnabled, setIsThinkingEnabled] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 384) + 'px';
    }
  }, [message]);

  // File handling
  const handleFiles = useCallback((newFilesList: FileList | File[]) => {
    const next: AttachedFile[] = Array.from(newFilesList).map((file) => {
      const isImage =
        file.type.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(file.name);
      return {
        id: newId(),
        file,
        type: isImage ? 'image/unknown' : file.type || 'application/octet-stream',
        preview: isImage ? URL.createObjectURL(file) : null,
        uploadStatus: 'pending' as const,
      };
    });
    setFiles((prev) => [...prev, ...next]);

    // Auto-complete status after a short delay (visual feedback)
    next.forEach((f) => {
      setTimeout(
        () => {
          setFiles((prev) =>
            prev.map((p) => (p.id === f.id ? { ...p, uploadStatus: 'complete' as const } : p)),
          );
        },
        800 + Math.random() * 600,
      );
    });
  }, []);

  // Drag & drop
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  };

  // Paste handling
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const pastedFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i]!.kind === 'file') {
        const f = items[i]!.getAsFile();
        if (f) pastedFiles.push(f);
      }
    }
    if (pastedFiles.length > 0) {
      e.preventDefault();
      handleFiles(pastedFiles);
      return;
    }
    const text = e.clipboardData.getData('text');
    if (text.length > 300) {
      e.preventDefault();
      setPastedContent((prev) => [
        ...prev,
        { id: newId(), content: text, timestamp: new Date() },
      ]);
    }
  };

  const send = () => {
    if (disabled) return;
    const trimmed = message.trim();
    if (!trimmed && files.length === 0 && pastedContent.length === 0) return;
    onSendMessage({
      message: trimmed,
      files,
      pastedContent,
      isThinkingEnabled,
    });
    setMessage('');
    setFiles([]);
    setPastedContent([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const hasContent =
    Boolean(message.trim()) || files.length > 0 || pastedContent.length > 0;

  return (
    <div
      className="relative w-full max-w-2xl mx-auto transition-all duration-300"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div
        className={`
          flex flex-col mx-2 md:mx-0 items-stretch transition-all duration-200 relative z-10
          rounded-2xl cursor-text border border-bg-300
          shadow-[0_0_15px_rgba(0,0,0,0.25)] hover:shadow-[0_0_20px_rgba(0,0,0,0.35)]
          focus-within:border-text-400 focus-within:shadow-[0_0_25px_rgba(0,0,0,0.45)]
          bg-bg-100
        `}
      >
        <div className="flex flex-col px-3 pt-3 pb-2 gap-2">
          {/* 1. Artifacts row */}
          {(files.length > 0 || pastedContent.length > 0) && (
            <div className="flex gap-3 overflow-x-auto scroll-thin pb-2 px-1">
              {pastedContent.map((c) => (
                <PastedContentCard
                  key={c.id}
                  content={c}
                  onRemove={(id) => setPastedContent((prev) => prev.filter((p) => p.id !== id))}
                />
              ))}
              {files.map((f) => (
                <FilePreviewCard
                  key={f.id}
                  file={f}
                  onRemove={(id) => setFiles((prev) => prev.filter((p) => p.id !== id))}
                />
              ))}
            </div>
          )}

          {/* 2. Textarea */}
          <div className="relative mb-1">
            <div className="max-h-96 w-full overflow-y-auto scroll-thin break-words min-h-[2.5rem] pl-1">
              <textarea
                ref={textareaRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onPaste={handlePaste}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                disabled={disabled}
                className="w-full bg-transparent border-0 outline-none text-text-100 text-[16px] placeholder:text-text-400 resize-none overflow-hidden py-0 leading-relaxed block font-normal"
                rows={1}
                autoFocus
                style={{ minHeight: '1.5em' }}
              />
            </div>
          </div>

          {/* 3. Action bar */}
          <div className="flex gap-2 w-full items-center">
            <div className="flex-1 flex items-center shrink min-w-0 gap-1">
              {/* Attach button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center justify-center relative shrink-0 transition-colors duration-200 h-8 w-8 rounded-lg active:scale-95 text-text-400 hover:text-text-200 hover:bg-bg-200"
                type="button"
                aria-label="Attach file"
                disabled={disabled}
              >
                <Plus className="w-5 h-5" />
              </button>

              {/* Extended thinking toggle */}
              {thinkingToggle && (
                <button
                  onClick={() => setIsThinkingEnabled((v) => !v)}
                  className={`group relative transition-all duration-200 h-8 px-2 flex items-center gap-1.5 rounded-lg active:scale-95 ${
                    isThinkingEnabled
                      ? 'text-accent bg-accent/10'
                      : 'text-text-400 hover:text-text-200 hover:bg-bg-200'
                  }`}
                  aria-pressed={isThinkingEnabled}
                  aria-label="Extended thinking"
                  disabled={disabled}
                >
                  <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                    <path d="M10.39 2.51A7.5 7.5 0 1 1 2.5 10a.5.5 0 0 1 1 0A6.5 6.5 0 1 0 10 3.5l-.1-.01A.5.5 0 0 1 10 2.5l.39.01ZM10 5.5a.5.5 0 0 1 .5.5v3.69l2.72 1.36a.5.5 0 1 1-.45.9L9.78 10.45A.5.5 0 0 1 9.5 10V6a.5.5 0 0 1 .5-.5Z" />
                  </svg>
                  <span className="text-[12px] font-medium hidden sm:inline">Think</span>
                </button>
              )}
            </div>

            <div className="flex flex-row items-center min-w-0 gap-1">
              {/* Send */}
              <button
                onClick={send}
                disabled={!hasContent || disabled}
                className={`
                  inline-flex items-center justify-center relative shrink-0 transition-colors h-8 w-8 rounded-xl active:scale-95
                  ${
                    hasContent && !disabled
                      ? 'bg-accent text-bg-0 hover:bg-accent-hover shadow-md'
                      : 'bg-accent/30 text-bg-0/60 cursor-default'
                  }
                `}
                type="button"
                aria-label="Send message"
              >
                {disabled ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowUp className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-bg-200/90 border-2 border-dashed border-accent rounded-2xl z-50 flex flex-col items-center justify-center backdrop-blur-sm pointer-events-none">
          <Archive className="w-10 h-10 text-accent mb-2 animate-bounce" />
          <p className="text-accent font-medium">Drop files to upload</p>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={(e) => {
          if (e.target.files) handleFiles(e.target.files);
          e.target.value = '';
        }}
        className="hidden"
      />
    </div>
  );
};

export default ChatInput;
