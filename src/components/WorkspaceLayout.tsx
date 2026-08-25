import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { CodebookPanel } from "./CodebookPanel";
import { TranscriptPanel } from "./TranscriptPanel";
import { MemoPanel } from "./MemoPanel";
import { InterviewMemoPanel } from "./InterviewMemoPanel";
import { Toolbar } from "./Toolbar";
import { ToastStack } from "./ToastStack";
import { NextStepCoach } from "./NextStepCoach";
import { ActivityLogPanel } from "./ActivityLogPanel";
import { BackupsPanel } from "./BackupsPanel";
import { ProjectFilesPanel } from "./ProjectFilesPanel";
import { CloseProjectModal } from "./CloseProjectModal";
import { ResetWorkspaceModal } from "./ResetWorkspaceModal";
import { ExportDialog } from "./ExportDialog";
import { ContextMenuHost } from "./ui/ContextMenu";

const DEFAULT_CODEBOOK = 248;
const DEFAULT_MEMOS = 300;
const MIN_PANEL = 190;
const MAX_CODEBOOK = 400;
const MAX_MEMOS = 480;
const RESIZER = 5;

/**
 * 🔑 The transcript's floor, and the reason the rails are not simply fixed.
 *
 * `tauri.conf.json` sets `minWidth: 1024`, and at 1024 the fixed rails left the
 * transcript 466px — a ~48-character measure at 15.5px serif, on the app's core
 * artifact, well under the 60–75 long-form reading wants. 512px here leaves
 * ~464px of prose inside `px-6`, which lands at about 60 characters.
 *
 * The rails give this up, not the transcript: a codebook can be read at 190px,
 * a paragraph cannot be read at 45 characters.
 */
const TRANSCRIPT_MIN = 512;

/**
 * Shrink the rails toward `MIN_PANEL` when the window cannot hold both them and
 * a readable transcript, taking from each in proportion to how much slack it
 * has. Returns the widths to *render* — the stored preference is untouched, so
 * widening the window restores exactly what the user chose.
 *
 * Exported for test: this is the one piece of the layout with arithmetic in it,
 * and the failure it guards against (the transcript silently squeezed below a
 * readable measure) is invisible until someone tries to read at 1024.
 */
export function fitRails(
  codebook: number,
  memos: number,
  viewport: number,
): { codebook: number; memos: number } {
  const overflow = codebook + memos + 2 * RESIZER + TRANSCRIPT_MIN - viewport;
  if (overflow <= 0) return { codebook, memos };

  const slackCodebook = Math.max(0, codebook - MIN_PANEL);
  const slackMemos = Math.max(0, memos - MIN_PANEL);
  const slack = slackCodebook + slackMemos;
  // Both rails already at their floor: the window is narrower than the app
  // claims to support, and the transcript takes what is left rather than
  // pushing a control off-screen.
  if (slack === 0) return { codebook, memos };

  const take = Math.min(overflow, slack);
  return {
    codebook: Math.round(codebook - (take * slackCodebook) / slack),
    memos: Math.round(memos - (take * slackMemos) / slack),
  };
}

/**
 * The width the rails actually have to divide up, observed on the element
 * rather than read from `window.innerWidth`.
 *
 * ⚠️ A `resize` listener is not equivalent. It misses every path that changes
 * the element's width without resizing the window, and it silently missed a
 * real one during testing: the viewport override used to check this layout
 * changes `innerWidth` without dispatching `resize`, so the rails stayed at
 * their old fitted widths while the `1fr` transcript grew on its own — the
 * layout looked half-updated and the cause was invisible. Observing the box
 * that matters has no such gap.
 */
function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1400 : window.innerWidth,
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function WorkspaceLayout() {
  const panelWidths = useAppStore((s) => s.preferences.panel_widths);
  const setPanelWidths = useAppStore((s) => s.setPanelWidths);
  const [codebookWidth, setCodebookWidth] = useState(
    panelWidths?.codebook ?? DEFAULT_CODEBOOK,
  );
  const [memosWidth, setMemosWidth] = useState(panelWidths?.memos ?? DEFAULT_MEMOS);
  const noteEditorCodingId = useProjectStore((s) => s.noteEditorCodingId);
  const showExportDialog = useProjectStore((s) => s.showExportDialog);
  const setShowExportDialog = useProjectStore((s) => s.setShowExportDialog);
  const showMemoRail = Boolean(noteEditorCodingId);

  const gridRef = useRef<HTMLDivElement>(null);
  const gridWidth = useElementWidth(gridRef);
  const rails = fitRails(
    codebookWidth,
    showMemoRail ? memosWidth : 0,
    gridWidth,
  );
  const dragging = useRef<"codebook" | "memos" | null>(null);
  const gridWidthRef = useRef(gridWidth);
  gridWidthRef.current = gridWidth;
  const widthsRef = useRef({ codebook: codebookWidth, memos: memosWidth });

  useEffect(() => {
    widthsRef.current = { codebook: codebookWidth, memos: memosWidth };
  }, [codebookWidth, memosWidth]);

  useEffect(() => {
    if (panelWidths) {
      setCodebookWidth(panelWidths.codebook);
      setMemosWidth(panelWidths.memos);
    }
  }, [panelWidths]);

  const onMouseMove = useCallback((e: MouseEvent) => {
    // The drag stops where the transcript would drop below TRANSCRIPT_MIN, so
    // a rail can never be dragged into clipping the reading column. Without
    // this the stored width and the rendered width disagree and the panel
    // simply stops following the cursor, which reads as a broken drag.
    const room = (other: number) =>
      gridWidthRef.current - other - 2 * RESIZER - TRANSCRIPT_MIN;

    if (dragging.current === "codebook") {
      const max = Math.min(MAX_CODEBOOK, room(widthsRef.current.memos));
      const w = Math.min(Math.max(MIN_PANEL, max), Math.max(MIN_PANEL, e.clientX));
      setCodebookWidth(w);
      widthsRef.current.codebook = w;
    }
    if (dragging.current === "memos") {
      const max = Math.min(MAX_MEMOS, room(widthsRef.current.codebook));
      const w = Math.min(
        Math.max(MIN_PANEL, max),
        Math.max(MIN_PANEL, gridWidthRef.current - e.clientX),
      );
      setMemosWidth(w);
      widthsRef.current.memos = w;
    }
  }, []);

  const onMouseUp = useCallback(() => {
    if (dragging.current) {
      const { codebook, memos } = widthsRef.current;
      setPanelWidths(codebook, memos);
      dragging.current = null;
    }
  }, [setPanelWidths]);

  useEffect(() => {
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Toolbar />

      <div
        ref={gridRef}
        data-testid="workspace-grid"
        className="relative grid min-h-0 flex-1 overflow-hidden"
        style={
          {
            gridTemplateColumns: showMemoRail
              ? `${rails.codebook}px ${RESIZER}px minmax(0, 1fr) ${RESIZER}px ${rails.memos}px`
              : `${rails.codebook}px ${RESIZER}px minmax(0, 1fr)`,
            gridTemplateRows: "minmax(0, 1fr)",
            // Published so NextStepCoach can sit over the transcript column
            // alone. It used to be `inset-x-0` across the whole grid, which
            // ran it under the memo rail and covered "Already on this passage".
            "--rail-l": `${rails.codebook + RESIZER}px`,
            "--rail-r": showMemoRail ? `${rails.memos + RESIZER}px` : "0px",
          } as React.CSSProperties
        }
      >
        <CodebookPanel />
        <Resizer onGrab={() => (dragging.current = "codebook")} />
        <TranscriptPanel />
        {showMemoRail && (
          <>
            <Resizer onGrab={() => (dragging.current = "memos")} />
            <MemoPanel />
          </>
        )}
        <NextStepCoach />
      </div>

      {/* No footer hint bar. It spent 28 permanent pixels repeating five
          shortcuts the coach, the guide, and the context menus already teach
          at the moment they matter; chrome that never changes is chrome that
          stops being read. */}
      <ToastStack />
      <CloseProjectModal />
      <ResetWorkspaceModal />
      <ExportDialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
      />
      <ActivityLogPanel />
      <BackupsPanel />
      <ProjectFilesPanel />
      <InterviewMemoPanel />
      <ContextMenuHost />
    </div>
  );
}

function Resizer({ onGrab }: { onGrab: () => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={onGrab}
      className="group relative cursor-col-resize"
    >
      <span
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:w-0.5"
        style={{ background: "var(--g-rim)" }}
      />
    </div>
  );
}
