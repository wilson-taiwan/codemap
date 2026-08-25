import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../store/project-store";
import { NoteEditor } from "./NoteEditor";

/** A typing pause, not a keystroke — long enough not to save mid-word. */
const AUTOSAVE_MS = 900;

type SaveState = "idle" | "saving" | "saved";

/**
 * Autosave a memo field.
 *
 * Preserved for interview-level memo (InterviewMemoPanel.tsx).
 */
export function useAutosaveMemo(
  value: string,
  dirty: boolean,
  save: (options?: { silent?: boolean }) => Promise<void>,
  enabled: boolean,
): SaveState {
  const [state, setState] = useState<SaveState>("idle");
  const latest = useRef({ dirty, save, enabled });
  useEffect(() => {
    latest.current = { dirty, save, enabled };
  });

  useEffect(() => {
    if (!enabled || !dirty) return;
    setState("idle");
    const timer = setTimeout(async () => {
      setState("saving");
      await save({ silent: true });
      setState("saved");
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [value, dirty, enabled, save]);

  useEffect(() => {
    const flush = () => {
      const { dirty: d, save: s, enabled: e } = latest.current;
      if (d && e) void s({ silent: true });
    };
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", flush);
      flush();
    };
  }, []);

  return state;
}

interface MemoPanelProps {
  onCloseRail?: () => void;
}

/**
 * The note on one coding. Explicit commit with Save & close / Discard (A7).
 */
export function MemoPanel({ onCloseRail }: MemoPanelProps) {
  const {
    noteEditorCodingId,
    closeNote,
    saveMemoForCoding,
    codes,
    segments,
    codedSegments,
  } = useProjectStore(
    useShallow((s) => ({
      noteEditorCodingId: s.noteEditorCodingId,
      closeNote: s.closeNote,
      saveMemoForCoding: s.saveMemoForCoding,
      codes: s.codes,
      segments: s.segments,
      codedSegments: s.codedSegments,
    })),
  );

  const handleClose = () => {
    closeNote();
    onCloseRail?.();
  };

  const coding = noteEditorCodingId
    ? codedSegments.find((c) => c.id === noteEditorCodingId) ?? null
    : null;

  if (!noteEditorCodingId || !coding) {
    return null;
  }

  const applied = codes.filter((c) => coding.code_ids.includes(c.id));
  const segment = segments.find((s) => s.id === coding.segment_id) ?? null;

  const handleSave = async (memo: string) => {
    await saveMemoForCoding(coding.id, memo);
  };

  const initialMemo = coding.memo ?? "";

  const title = (
    <div className="flex flex-col gap-1">
      <span className="eyebrow">
        {segment ? `Passage ${segment.segment_index + 1}` : "Note"}
      </span>
      {applied.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {applied.map((c) => (
            <span
              key={c.id}
              className="rounded-full px-2 py-0.5 text-[10.5px] font-medium text-white"
              style={{ backgroundColor: c.color }}
            >
              {c.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  const subtitle =
    coding.char_start != null && coding.char_end != null && segment ? (
      <span className="line-clamp-2 block font-serif italic text-[11.5px] pt-1">
        “{segment.text.slice(coding.char_start, coding.char_end)}”
      </span>
    ) : undefined;

  return (
    <aside
      data-testid="memo-panel"
      className="glass-panel flex h-full min-h-0 flex-col overflow-hidden"
    >
      <div className="scroll flex flex-1 min-h-0 flex-col overflow-y-auto overflow-x-hidden overscroll-contain p-4">
        <NoteEditor
          initialMemo={initialMemo}
          title={title}
          subtitle={subtitle}
          onSave={handleSave}
          onClose={handleClose}
          autoFocus={true}
          className="flex-1"
        />
      </div>
    </aside>
  );
}
