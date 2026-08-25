import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./ui/Icon";
import { modKey, isMac } from "../lib/platform";

interface NoteEditorProps {
  initialMemo: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  onSave: (memo: string) => Promise<void>;
  onClose: () => void;
  autoFocus?: boolean;
  className?: string;
}

export function NoteEditor({
  initialMemo,
  title,
  subtitle,
  onSave,
  onClose,
  autoFocus = false,
  className = "",
}: NoteEditorProps) {
  const [draft, setDraft] = useState(initialMemo);
  const [savedMemo, setSavedMemo] = useState(initialMemo);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isDirty = draft !== savedMemo;

  useEffect(() => {
    setDraft(initialMemo);
    setSavedMemo(initialMemo);
    setShowDiscardConfirm(false);
    setError(null);
  }, [initialMemo]);

  const handleSaveAndClose = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setSavedMemo(draft);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      textareaRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }, [draft, onSave, onClose, saving]);

  const handleAttemptClose = useCallback(() => {
    if (isDirty) {
      setShowDiscardConfirm(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  const handleConfirmDiscard = () => {
    setDraft(savedMemo);
    setShowDiscardConfirm(false);
    setError(null);
    onClose();
  };

  const handleCancelDiscard = () => {
    setShowDiscardConfirm(false);
    textareaRef.current?.focus();
  };

  // Keyboard navigation: ⌘Enter / Ctrl+Enter saves; Esc attempts discard / cancel
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;

    if (mod && e.key === "Enter") {
      e.preventDefault();
      void handleSaveAndClose();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      handleAttemptClose();
      return;
    }
  };

  return (
    <div
      ref={containerRef}
      className={`flex flex-col ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-2">
        <div className="min-w-0 flex-1">
          {title && <div className="text-[13px] font-medium leading-tight">{title}</div>}
          {subtitle && (
            <div className="text-[11.5px] text-[var(--ink-3)]">{subtitle}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <span
              className="text-[11px] font-medium text-[var(--accent)]"
              role="status"
            >
              Editing · unsaved
            </span>
          )}
          <button
            type="button"
            onClick={handleAttemptClose}
            aria-label="Close note editor"
            className="grid h-6 w-6 place-items-center rounded-md text-[var(--ink-3)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)]"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </div>

      {/* Textarea */}
      <div className="flex-1 flex flex-col min-h-0">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
          placeholder="Why does this passage get this coding? Record your reasoning…"
          aria-label="Note content"
          className="field flex-1 resize-none text-[13px] leading-relaxed p-2.5 min-h-[120px]"
        />
      </div>

      {error && (
        <div
          role="alert"
          className="mt-2 rounded-md bg-[var(--danger,#b03a34)]/10 px-2.5 py-1.5 text-[11.5px] text-[var(--danger,#b03a34)]"
        >
          Failed to save note: {error}
        </div>
      )}

      {/* Footer / Inline Confirm Strip */}
      <div className="mt-2.5 pt-2 border-t border-[var(--g-rim)]/60">
        {showDiscardConfirm ? (
          <div className="flex flex-col gap-2 rounded-lg bg-[var(--fill)] p-2">
            <span className="text-[11.5px] font-medium text-[var(--danger,#b03a34)]">
              Discard changes to this note?
            </span>
            <div className="flex items-center gap-1.5 justify-end">
              <button
                type="button"
                onClick={handleCancelDiscard}
                className="btn btn-ghost btn-xs"
              >
                Keep editing
              </button>
              <button
                type="button"
                onClick={handleConfirmDiscard}
                className="btn btn-danger btn-xs"
              >
                Discard
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="hint text-[10.5px]">
              {modKey}↵ to save · Esc to close
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleAttemptClose}
                disabled={saving}
                className="btn btn-ghost btn-sm text-[var(--danger,#b03a34)] hover:bg-[var(--danger,#b03a34)]/10"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => void handleSaveAndClose()}
                disabled={saving}
                className="btn btn-primary btn-sm"
              >
                {saving ? "Saving…" : "Save & close"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
