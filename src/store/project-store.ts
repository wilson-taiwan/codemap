import { create } from "zustand";
import { confirm } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../lib/api";
import { parseTranscriptFile } from "../hooks/useVttParser";
import type { TranscriptFormat } from "../lib/transcript-parser";

/** What to call each format when reporting what was just read. */
const FORMAT_LABELS: Record<TranscriptFormat, string> = {
  vtt: "a WebVTT caption file",
  srt: "an SRT subtitle file",
  csv: "a spreadsheet",
  text: "a plain-text transcript",
};
import { debounce } from "../lib/debounce";
import { nextCodeColor } from "../lib/code-colors";
import { computeInterviewCodedCount } from "../lib/store-helpers";
import { CODE_PALETTE } from "../lib/code-colors";
import { useAppStore } from "./app-store";
import type { ExportConfig } from "../lib/export-config";
import { generateHtmlReport } from "../lib/report-html";
import { buildFrameworkMatrix, generateFrameworkMatrixCsv } from "../lib/framework-matrix";
import { fileManagerName } from "../lib/platform";
import type { SelectIntent } from "../lib/scroll-into-view";
import type {
  ActivityLogEntry,
  Code,
  CodedSegment,
  DeleteCodeMode,
  Interview,
  InterviewDeleteImpact,
  LiveWorkspaceSnapshot,
  ProjectInfo,
  ProjectOpenSnapshot,
  RestoreOutcome,
  Toast,
  ToastAction,
  TranscriptSegment,
} from "../lib/types";

function pushRecentCode(recentIds: string[], codeId: string): string[] {
  const filtered = recentIds.filter((id) => id !== codeId);
  return [codeId, ...filtered].slice(0, 6);
}

async function confirmHubMemoIfDirty(
  hubMemoDirty: boolean,
): Promise<boolean> {
  if (!hubMemoDirty) return true;
  return confirm(
    "Interview analytic memo has unsaved changes. Continue without saving?",
    { title: "Unsaved hub memo", kind: "warning" },
  );
}

async function rememberIdentity(path: string, coder: string) {
  try {
    const prefs = await api.getAppPreferences();
    await api.setAppPreferences({
      ...prefs,
      coder_identities: { ...(prefs.coder_identities ?? {}), [path]: coder },
    });
  } catch {
    // non-fatal — worst case the app asks again next time
  }
}

function dedupeCoders(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((c) => {
    const key = c.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function recordRecentFromProject(project: ProjectInfo) {
  try {
    await api.recordRecentProject({
      path: project.path,
      title: project.title,
      last_handoff_by: project.last_saved_by,
      last_handoff_at: project.last_saved_at,
    });
  } catch {
    // non-fatal
  }
}
interface ProjectStore {
  project: ProjectInfo | null;
  activeCoder: string;
  interviews: Interview[];
  activeInterviewId: string | null;
  segments: TranscriptSegment[];
  codes: Code[];
  codedSegments: CodedSegment[];
  retiredCodes: Code[];
  syncConflicts: LiveWorkspaceSnapshot["conflicts"];
  liveSyncStatus: LiveWorkspaceSnapshot["sync_status"] | null;
  localRevision: number;
  totalCodedCount: number;
  interviewCodedCount: number;
  selectedSegmentId: string | null;
  selectedCodeIds: string[];
  hubMemo: string;
  savedHubMemo: string;
  hubMemoDirty: boolean;
  loading: boolean;
  openingPath: string | null;
  error: string | null;
  toasts: Toast[];
  exporting: boolean;
  /**
   * Whether the person at the keyboard has actually said who they are. Coding
   * is blocked until they have — an unattributed code is worse than no code.
   */
  coderConfirmed: boolean;
  /** Ask who is at the keyboard. Coding is refused until this is answered. */
  showIdentityPrompt: boolean;
  transcriptSearch: string;
  showActivityLog: boolean;
  showProjectFiles: boolean;
  showBackups: boolean;
  /**
   * The stretch of a passage the coder has selected, if any.
   *
   * Set by dragging over transcript text; cleared once applied or dismissed.
   * When present, applying codes marks exactly this span rather than the whole
   * speaker turn.
   */
  pendingSelection: {
    segmentId: string;
    start: number;
    end: number;
    text: string;
  } | null;
  /**
   * Which coding's note the right rail is open for, or null for closed.
   * Holds the stable coded-segment id. The rail renders only while this is non-null.
   */
  noteEditorCodingId: string | null;
  /**
   * The interview-wide memo sheet.
   */
  showInterviewMemo: boolean;
  setShowInterviewMemo: (open: boolean) => void;
  openNoteForCoding: (codingId: string) => void;
  closeNote: () => void;
  /** Show only passages carrying this code. Null shows the whole transcript. */
  codeFilter: string | null;
  showCloseConfirm: boolean;
  showResetConfirm: boolean;

  setActiveCoder: (name: string) => void;
  setSelectedCodeIds: (ids: string[]) => void;
  toggleCodeSelection: (id: string) => void;
  toggleCodeOnTarget: (codeId: string) => Promise<void>;
  /**
   * Reversible coding actions, most recent last.
   */
  undoStack: {
    label: string;
    undo: () => Promise<void>;
    redo: () => Promise<void>;
  }[];
  redoStack: {
    label: string;
    undo: () => Promise<void>;
    redo: () => Promise<void>;
  }[];
  pushUndo: (
    label: string,
    undo: () => Promise<void>,
    redo: () => Promise<void>,
  ) => void;
  undoLastCoding: () => Promise<void>;
  redoLastCoding: () => Promise<void>;
  saveMemoForCoding: (
    codedSegmentId: string,
    memo: string,
    options?: { silent?: boolean },
  ) => Promise<CodedSegment>;
  currentCodingTarget: () => {
    segmentId: string;
    span: { start: number; end: number; text: string } | null;
    existing: CodedSegment | null;
  } | null;
  setHubMemo: (memo: string) => void;
  selectionIntent: SelectIntent;
  setSelectedSegmentId: (id: string | null, intent?: SelectIntent) => void;
  setTranscriptSearch: (query: string) => void;
  clearError: () => void;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
  showStatus: (
    text: string,
    type?: "success" | "error" | "info",
    action?: ToastAction,
  ) => string;
  removeCodeFromCoding: (codingId: string, codeId: string) => Promise<void>;
  clearMemoForCoding: (codingId: string) => Promise<void>;
  recentCodeIds: string[];
  openExportsFolder: (exportsDir: string) => Promise<void>;
  confirmCoder: (name: string) => Promise<void>;
  adoptCoderName: (name: string) => void;
  adoptProjectTitle: (title: string) => void;
  dismissIdentityPrompt: () => void;

  openProject: (path: string) => Promise<void>;
  hydrateOpenedSnapshot: (snapshot: ProjectOpenSnapshot) => void;
  reconcileLiveWorkspace: (snapshot: LiveWorkspaceSnapshot) => void;
  createProject: (
    parentDir: string,
    projectName: string,
    title: string,
    coders: string[],
  ) => Promise<boolean>;
  seedCodes: (codes: { name: string; definition?: string }[]) => Promise<void>;
  closeProject: () => Promise<void>;
  requestCloseProject: () => Promise<void>;
  refreshProject: () => Promise<void>;
  requestExportProject: () => Promise<void>;
  loadCodes: () => Promise<void>;
  addCode: (name: string, color?: string, definition?: string) => Promise<Code>;
  /**
   * Create a code and put it straight on the current target.
   *
   * One action rather than two, because in reflexive TA the overwhelmingly
   * common way a code is born is *from* a passage — you read something, you
   * name it, and the naming and the applying are one thought. Splitting it left
   * the coder to find their new code in a list they just added to.
   */
  createCodeAndApply: (name: string) => Promise<void>;
  updateCode: (input: {
    id: string;
    name: string;
    definition?: string | null;
    inclusion_criteria?: string | null;
    exclusion_criteria?: string | null;
    example?: string | null;
    parent_id?: string | null;
    color: string;
  }) => Promise<void>;
  reparentCode: (codeId: string, newParentId: string | null) => Promise<void>;
  deleteCode: (codeId: string, mode: DeleteCodeMode) => Promise<void>;
  restoreCode: (codeId: string) => Promise<void>;
  loadRetiredCodes: () => Promise<Code[]>;
  removeCodedSegment: (codedSegmentId: string) => Promise<void>;
  loadInterviews: () => Promise<void>;
  renameInterview: (
    id: string,
    label: string,
    date?: string | null,
  ) => Promise<void>;
  deleteInterview: (id: string) => Promise<void>;
  interviewDeleteImpact: (id: string) => Promise<InterviewDeleteImpact>;
  selectInterview: (
    id: string,
    preferredSegmentId?: string | null,
    options?: { persist?: boolean },
  ) => Promise<void>;
  restoreWorkspace: () => Promise<void>;
  persistWorkspace: () => Promise<void>;
  refreshCodedCount: () => Promise<void>;
  createInterview: (label: string, date?: string) => Promise<Interview>;
  importVtt: (vttPath: string) => Promise<number>;
  loadCodedSegments: (codeId?: string) => Promise<void>;
  saveHubMemo: (options?: { silent?: boolean }) => Promise<void>;
  selectAdjacentSegment: (direction: "prev" | "next") => void;
  setShowActivityLog: (open: boolean) => void;
  setShowProjectFiles: (open: boolean) => void;
  setShowBackups: (open: boolean) => void;
  setPendingSelection: (
    selection: {
      segmentId: string;
      start: number;
      end: number;
      text: string;
    } | null,
  ) => void;
  setCodeFilter: (codeId: string | null) => void;
  restoreFromBackup: (backupPath: string) => Promise<RestoreOutcome>;
  loadActivity: () => Promise<ActivityLogEntry[]>;
  dismissCloseConfirm: () => void;
  confirmCloseProject: () => Promise<void>;
  requestResetWorkspace: () => Promise<void>;
  dismissResetConfirm: () => void;
  confirmResetWorkspace: (opts: {
    scope: "all" | "active";
    clearHubMemos: boolean;
    clearActivityLog: boolean;
  }) => Promise<void>;
  showExportDialog: boolean;
  setShowExportDialog: (open: boolean) => void;
  exportWithConfig: (
    targetDir: string,
    config: ExportConfig,
  ) => Promise<import("../lib/types").ExportResult | null>;
}

const persistWorkspaceDebounced = debounce(() => {
  useProjectStore.getState().persistWorkspace().catch(() => {});
}, 250);

function sameSpan(
  a: { start: number; end: number } | null,
  b: { start: number; end: number } | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.start === b.start && a.end === b.end;
}

type CodingTargetInput = {
  interviewId: string;
  segmentId: string;
  coderName: string;
  span: { start: number; end: number } | null;
};

function codingMatchesTarget(
  coding: CodedSegment,
  target: CodingTargetInput,
): boolean {
  return (
    coding.interview_id === target.interviewId &&
    coding.segment_id === target.segmentId &&
    coding.coder_name === target.coderName &&
    (target.span
      ? coding.char_start === target.span.start && coding.char_end === target.span.end
      : coding.char_start == null && coding.char_end == null)
  );
}

function reconcileCodingTarget(
  get: () => ProjectStore,
  set: (partial: Partial<ProjectStore>) => void,
  target: CodingTargetInput,
  codedSegment: CodedSegment | null,
): void {
  const state = get();
  const previous = state.codedSegments.find((coding) =>
    codingMatchesTarget(coding, target),
  );
  const codedSegments = [
    ...state.codedSegments.filter((coding) => !codingMatchesTarget(coding, target)),
    ...(codedSegment ? [codedSegment] : []),
  ];
  const selectionSpan =
    state.pendingSelection &&
    state.pendingSelection.segmentId === state.selectedSegmentId
      ? state.pendingSelection
      : null;
  const stillSelected =
    state.activeCoder === target.coderName &&
    state.selectedSegmentId === target.segmentId &&
    sameSpan(selectionSpan, target.span);
  const changedInActiveInterview = state.activeInterviewId === target.interviewId;
  const totalCodedCount = changedInActiveInterview
    ? state.totalCodedCount + Number(Boolean(codedSegment)) - Number(Boolean(previous))
    : state.totalCodedCount;
  set({
    codedSegments,
    interviewCodedCount: computeInterviewCodedCount(codedSegments),
    totalCodedCount,
    ...(stillSelected
      ? { selectedCodeIds: codedSegment ? [...codedSegment.code_ids] : [] }
      : {}),
  });
}

async function mutateCodingEdgeOnTarget(
  get: () => ProjectStore,
  set: (partial: Partial<ProjectStore>) => void,
  input: CodingTargetInput & { codeId: string; present: boolean },
) {
  const result = await api.mutateCodingEdge({
    interview_id: input.interviewId,
    segment_id: input.segmentId,
    code_id: input.codeId,
    coder_name: input.coderName,
    char_start: input.span?.start,
    char_end: input.span?.end,
    present: input.present,
  });
  reconcileCodingTarget(get, set, input, result.coded_segment);
  return result;
}

function reconcilePatchedCoding(
  get: () => ProjectStore,
  set: (partial: Partial<ProjectStore>) => void,
  codedSegment: CodedSegment,
): void {
  const target: CodingTargetInput = {
    interviewId: codedSegment.interview_id,
    segmentId: codedSegment.segment_id,
    coderName: codedSegment.coder_name,
    span:
      codedSegment.char_start != null && codedSegment.char_end != null
        ? { start: codedSegment.char_start, end: codedSegment.char_end }
        : null,
  };
  reconcileCodingTarget(get, set, target, codedSegment);
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  project: null,
  // Deliberately blank. A default name means a teammate's coding silently gets
  // filed under whoever the app was built for.
  activeCoder: "",
  interviews: [],
  activeInterviewId: null,
  segments: [],
  codes: [],
  codedSegments: [],
  retiredCodes: [],
  syncConflicts: [],
  liveSyncStatus: null,
  localRevision: 0,
  totalCodedCount: 0,
  interviewCodedCount: 0,
  selectedSegmentId: null,
  selectedCodeIds: [],
  undoStack: [],
  redoStack: [],
  hubMemo: "",
  savedHubMemo: "",
  hubMemoDirty: false,
  loading: false,
  openingPath: null,
  error: null,
  toasts: [],
  recentCodeIds: [],
  exporting: false,
  coderConfirmed: false,
  showIdentityPrompt: false,
  transcriptSearch: "",
  showActivityLog: false,
  showProjectFiles: false,
  showBackups: false,
  pendingSelection: null,
  noteEditorCodingId: null,
  showInterviewMemo: false,
  codeFilter: null,
  showCloseConfirm: false,
  showResetConfirm: false,
  showExportDialog: false,
  selectionIntent: "restore",

  setActiveCoder: (name) => {
    set({ activeCoder: name, coderConfirmed: name !== "" });
    const path = get().project?.path;
    if (path && name) rememberIdentity(path, name).catch(() => {});
    get().persistWorkspace().catch(() => {});
  },
  openNoteForCoding: (codingId) => set({ noteEditorCodingId: codingId }),
  closeNote: () => set({ noteEditorCodingId: null }),
  setShowInterviewMemo: (open) => set({ showInterviewMemo: open }),

  setSelectedCodeIds: (ids) => set({ selectedCodeIds: ids }),
  toggleCodeSelection: (id) => {
    const current = get().selectedCodeIds;
    if (current.includes(id)) {
      set({ selectedCodeIds: current.filter((c) => c !== id) });
    } else {
      set({ selectedCodeIds: [...current, id] });
    }
  },
  setHubMemo: (memo) => {
    const saved = get().savedHubMemo;
    set({ hubMemo: memo, hubMemoDirty: memo !== saved });
  },
  /**
   * The coding row the codebook's ticks refer to right now.
   *
   * A passage plus, when text is selected inside it, that span — so ticking a
   * code marks the phrase rather than the whole turn. Returns the existing row
   * for that exact target if there is one, which is what makes a tick a
   * *toggle* rather than an overwrite.
   */
  currentCodingTarget: () => {
    const { selectedSegmentId, pendingSelection, codedSegments, activeCoder } =
      get();
    if (!selectedSegmentId) return null;

    const span =
      pendingSelection && pendingSelection.segmentId === selectedSegmentId
        ? pendingSelection
        : null;

    const existing = codedSegments.find(
      (c) =>
        c.segment_id === selectedSegmentId &&
        c.coder_name === activeCoder &&
        (span
          ? c.char_start === span.start && c.char_end === span.end
          : c.char_start == null && c.char_end == null),
    );

    return { segmentId: selectedSegmentId, span, existing: existing ?? null };
  },

  /**
   * Apply or remove one code, immediately.
   *
   * 🔑 This replaces a two-step "tick, then Apply" that was the app's single
   * worst confusion. The ticks always *reflected* what was applied — selecting
   * a passage loads its codes into them — but toggling one only staged an
   * intention, so a coder ticked three codes, saw the transcript not change,
   * and reasonably concluded the app was broken. A checkbox means membership
   * everywhere else in computing; now it means membership here.
   *
   * Unticking the last code removes the row rather than leaving one carrying no
   * codes: a coding that codes nothing is not a record of anything, and it
   * would still count toward "passages coded".
   */
  toggleCodeOnTarget: async (codeId) => {
    const { activeInterviewId, activeCoder, coderConfirmed } = get();
    const target = get().currentCodingTarget();
    if (!activeInterviewId || !target) {
      get().showStatus("Click a passage in the transcript first.", "info");
      return;
    }
    if (!coderConfirmed || !activeCoder) {
      get().showStatus("Choose who is coding before applying codes.", "error");
      set({ showIdentityPrompt: true });
      return;
    }

    const applied = target.existing?.code_ids ?? [];
    const present = !applied.includes(codeId);
    const next = present ? [...applied, codeId] : applied.filter((c) => c !== codeId);
    const codeName = get().codes.find((c) => c.id === codeId)?.name ?? "code";
    const edgeTarget = {
      interviewId: activeInterviewId,
      segmentId: target.segmentId,
      coderName: activeCoder,
      span: target.span,
      codeId,
    };

    // Optimistic, so the tick responds under the cursor rather than after a
    // round trip to SQLite.
    set({ selectedCodeIds: next });
    if (present) {
      set({ recentCodeIds: pushRecentCode(get().recentCodeIds, codeId) });
    }

    try {
      await mutateCodingEdgeOnTarget(get, set, { ...edgeTarget, present });

      get().pushUndo(
        present ? `Applied "${codeName}"` : `Removed "${codeName}"`,
        async () => {
          await mutateCodingEdgeOnTarget(get, set, {
            ...edgeTarget,
            present: !present,
          });
        },
        async () => {
          await mutateCodingEdgeOnTarget(get, set, { ...edgeTarget, present });
        },
      );
    } catch (e) {
      set({ selectedCodeIds: applied });
      get().showStatus("Could not change coding: " + String(e), "error");
    }
  },

  saveMemoForCoding: async (codedSegmentId, memo, options) => {
    const row = get().codedSegments.find((coding) => coding.id === codedSegmentId);
    if (!row) {
      throw new Error(`Coding row ${codedSegmentId} not found`);
    }

    try {
      const updated = await api.patchCodingMemo({
        coded_segment_id: row.id,
        memo: memo || undefined,
      });
      reconcilePatchedCoding(get, set, updated);
      if (!options?.silent) get().showStatus("Note saved.");
      return updated;
    } catch (e) {
      get().showStatus("Could not save the note: " + String(e), "error");
      throw e;
    }
  },

  pushUndo: (label, undo, redo) => {
    // Bounded: an unbounded stack holds a closure over every coding decision
    // of a long session, and nobody reaches back further than a few steps.
    const next = [...get().undoStack, { label, undo, redo }].slice(-25);
    // A fresh action is the point where the redo history stops describing a
    // possible present — replaying it from here would apply changes to a
    // state they never belonged to.
    set({ undoStack: next, redoStack: [] });
  },

  undoLastCoding: async () => {
    const stack = get().undoStack;
    const last = stack[stack.length - 1];
    if (!last) {
      get().showStatus("Nothing to undo.", "info");
      return;
    }

    // Popped before running: a failed undo must not sit at the top of the
    // stack inviting a retry that fails the same way.
    set({ undoStack: stack.slice(0, -1) });
    try {
      await last.undo();
      // Redoable only once it has genuinely been undone — a failed undo
      // leaves the world unchanged, so there is nothing to replay.
      set({ redoStack: [...get().redoStack, last].slice(-25) });
      get().showStatus(`Undone — ${last.label.toLowerCase()}.`);
    } catch (e) {
      get().showStatus("Could not undo: " + String(e), "error");
    }
  },

  redoLastCoding: async () => {
    const stack = get().redoStack;
    const last = stack[stack.length - 1];
    if (!last) {
      get().showStatus("Nothing to redo.", "info");
      return;
    }

    set({ redoStack: stack.slice(0, -1) });
    try {
      await last.redo();
      // Back on the undo stack: a redone action is again something you can
      // undo, which is what makes ⌘Z / ⇧⌘Z walk back and forth freely.
      set({ undoStack: [...get().undoStack, last].slice(-25) });
      get().showStatus(`Redone — ${last.label.toLowerCase()}.`);
    } catch (e) {
      get().showStatus("Could not redo: " + String(e), "error");
    }
  },

  setSelectedSegmentId: (id, intent = "jump") => {
    if (id !== get().selectedSegmentId || intent !== get().selectionIntent) {
      const { codedSegments, activeCoder } = get();
      let selectedCodeIds: string[] = [];
      if (id !== null) {
        const existing = codedSegments.find(
          (c) =>
            c.segment_id === id &&
            c.coder_name === activeCoder &&
            c.char_start == null &&
            c.char_end == null,
        );
        if (existing) {
          selectedCodeIds = [...existing.code_ids];
        }
      }
      set({
        selectedSegmentId: id,
        selectedCodeIds,
        selectionIntent: intent,
      });
    }
    persistWorkspaceDebounced();
  },
  setTranscriptSearch: (query) => set({ transcriptSearch: query }),
  clearError: () => set({ error: null }),
  dismissToast: (id: string) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }));
  },
  clearToasts: () => set({ toasts: [] }),
  showStatus: (text, type = "success", action) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const toast: Toast = { id, type, text, action };
    set((state) => {
      const updated = [...state.toasts, toast];
      const nextToasts =
        updated.length > 3 ? updated.slice(updated.length - 3) : updated;
      return {
        toasts: nextToasts,
      };
    });
    return id;
  },

  openExportsFolder: async (exportsDir) => {
    try {
      await openPath(exportsDir);
    } catch (e) {
      get().showStatus(String(e), "error");
    }
  },

  openProject: async (path) => {
    set({
      loading: true,
      openingPath: path,
      error: null,
    });
    // Yield one animation frame so the clicked recent row paints busy state
    if (typeof requestAnimationFrame !== "undefined") {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    try {
      const snapshot = await api.openProject(path);
      get().hydrateOpenedSnapshot(snapshot);
    } catch (e) {
      set({ loading: false, openingPath: null, error: String(e) });
      throw e;
    }
  },

  hydrateOpenedSnapshot: (snapshot: ProjectOpenSnapshot) => {
    const {
      project,
      codes,
      interviews,
      active_interview_id,
      selected_segment_id,
      segments,
      coded_segments,
      total_coded_count,
      recent_code_ids,
    } = snapshot;

    const prefs = useAppStore.getState().preferences;
    const remembered = prefs.coder_identities?.[project.path] ?? null;
    const inferred =
      remembered && project.coders.includes(remembered)
        ? remembered
        : project.coders.length === 1
          ? project.coders[0]
          : null;

    let selectedCodeIds: string[] = [];
    if (selected_segment_id && inferred) {
      const existing = coded_segments.find(
        (c) =>
          c.segment_id === selected_segment_id &&
          c.coder_name === inferred &&
          c.char_start == null &&
          c.char_end == null,
      );
      if (existing) {
        selectedCodeIds = [...existing.code_ids];
      }
    }

    set({
      project,
      codes,
      interviews,
      activeInterviewId: active_interview_id,
      selectedSegmentId: selected_segment_id,
      selectedCodeIds,
      segments,
      codedSegments: coded_segments,
      totalCodedCount: total_coded_count,
      interviewCodedCount: coded_segments.length,
      recentCodeIds:
        recent_code_ids && recent_code_ids.length > 0
          ? recent_code_ids
          : codes.slice(0, 6).map((c) => c.id),
      activeCoder: inferred ?? "",
      coderConfirmed: inferred !== null,
      showIdentityPrompt: inferred === null,
      transcriptSearch: "",
      codeFilter: null,
      noteEditorCodingId: null,
      undoStack: [],
      redoStack: [],
      loading: false,
      openingPath: null,
      error: null,
    });

    setTimeout(() => {
      void recordRecentFromProject(project);
    }, 50);
  },

  reconcileLiveWorkspace: (snapshot) => {
    const current = get();
    const activeInterviewId = current.activeInterviewId && snapshot.interviews.some(
      (interview) => interview.id === current.activeInterviewId,
    )
      ? current.activeInterviewId
      : snapshot.active_interview_id;
    const usesSnapshotActiveInterview = activeInterviewId === snapshot.active_interview_id;
    const activeInterviewChanged = activeInterviewId !== current.activeInterviewId;
    const segments = usesSnapshotActiveInterview ? snapshot.segments : current.segments;
    const codedSegments = usesSnapshotActiveInterview
      ? snapshot.coded_segments
      : current.codedSegments;
    const currentSelectionIsValid = current.selectedSegmentId !== null && segments.some(
      (segment) => segment.id === current.selectedSegmentId,
    );
    const selectedSegmentId = activeInterviewChanged
      ? snapshot.selected_segment_id
      : current.selectedSegmentId === null
        ? null
        : currentSelectionIsValid
          ? current.selectedSegmentId
          : snapshot.selected_segment_id;
    const selectionChanged = current.selectedSegmentId !== selectedSegmentId;
    const pendingSelection = current.pendingSelection &&
      current.pendingSelection.segmentId === selectedSegmentId &&
      segments.some((segment) => segment.id === current.pendingSelection?.segmentId)
      ? current.pendingSelection
      : null;
    const selectedSpan = pendingSelection
      ? { start: pendingSelection.start, end: pendingSelection.end }
      : null;
    const selectedCoding = selectedSegmentId
      ? codedSegments.find(
          (coding) =>
            coding.segment_id === selectedSegmentId &&
            coding.coder_name === current.activeCoder &&
            sameSpan(
              coding.char_start != null && coding.char_end != null
                ? { start: coding.char_start, end: coding.char_end }
                : null,
              selectedSpan,
            ),
        )
      : null;
    const codeIds = new Set(snapshot.codes.map((code) => code.id));
    const selectedCodeIds = selectedCoding
      ? selectedCoding.code_ids.filter((id) => codeIds.has(id))
      : selectedSegmentId === null || selectionChanged
        ? []
        : current.selectedCodeIds.filter((id) => codeIds.has(id));
    const activeInterview = snapshot.interviews.find(
      (interview) => interview.id === activeInterviewId,
    );
    const noteEditorSurvives = !current.noteEditorCodingId || codedSegments.some(
      (coding) => coding.id === current.noteEditorCodingId,
    );

    set({
      project: snapshot.project,
      interviews: snapshot.interviews,
      codes: snapshot.codes,
      retiredCodes: snapshot.retired_codes,
      activeInterviewId,
      segments,
      codedSegments,
      totalCodedCount: snapshot.coded_count,
      interviewCodedCount: computeInterviewCodedCount(codedSegments),
      selectedSegmentId,
      selectedCodeIds,
      pendingSelection,
      noteEditorCodingId: noteEditorSurvives ? current.noteEditorCodingId : null,
      syncConflicts: snapshot.conflicts,
      liveSyncStatus: snapshot.sync_status,
      localRevision: snapshot.local_revision,
      ...(activeInterviewId !== current.activeInterviewId && !current.hubMemoDirty
        ? {
            hubMemo: activeInterview?.hub_memo ?? "",
            savedHubMemo: activeInterview?.hub_memo ?? "",
            hubMemoDirty: false,
          }
        : {}),
    });

    if (!noteEditorSurvives) {
      get().showStatus("The coding for this note was removed during sync.", "info");
    }
    if (activeInterviewId !== current.activeInterviewId && current.hubMemoDirty) {
      get().showStatus("Your unsaved interview memo was kept while sync selected another interview.", "info");
    }
  },

  confirmCoder: async (name) => {
    const path = get().project?.path;
    set({ activeCoder: name, coderConfirmed: true, showIdentityPrompt: false });
    if (path) await rememberIdentity(path, name);
  },

  adoptCoderName: (name) => {
    const project = get().project;
    const trimmed = name.trim();
    if (!trimmed) return;
    const from =
      get().activeCoder.trim() ||
      (project?.coders.length === 1 ? project.coders[0] : "");
    if (!project) {
      set({ activeCoder: trimmed, coderConfirmed: true, showIdentityPrompt: false });
      return;
    }
    const fromLower = from.toLowerCase();
    const mapped = from
      ? project.coders.map((c) => (c.toLowerCase() === fromLower ? trimmed : c))
      : project.coders;
    const has = mapped.some((c) => c.toLowerCase() === trimmed.toLowerCase());
    const nextCoders = has ? dedupeCoders(mapped) : [...mapped, trimmed];
    set({
      project: { ...project, coders: nextCoders },
      activeCoder: trimmed,
      coderConfirmed: true,
      showIdentityPrompt: false,
    });
    void (async () => {
      try {
        const updated = await api.adoptProjectCoder(from, trimmed);
        const current = get().project;
        if (current?.path === updated.path) {
          set({ project: updated, activeCoder: trimmed });
        }
        await rememberIdentity(updated.path, trimmed);
      } catch {
        void rememberIdentity(project.path, trimmed);
      }
    })();
  },

  adoptProjectTitle: (title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const project = get().project;
    if (!project || project.title === trimmed) return;
    set({ project: { ...project, title: trimmed } });
    void (async () => {
      try {
        const updated = await api.adoptProjectTitle(trimmed);
        const current = get().project;
        if (current && current.path === updated.path) {
          set({ project: updated });
        }
      } catch {
        // Best effort
      }
    })();
  },

  dismissIdentityPrompt: () => set({ showIdentityPrompt: false }),

  createProject: async (parentDir, projectName, title, coders) => {
    set({ loading: true, openingPath: projectName, error: null });
    try {
      const project = await api.createProject({
        parent_dir: parentDir,
        project_name: projectName,
        title,
        coders,
      });
      // The only moment the app genuinely knows who is at the keyboard: they
      // just typed the coder list themselves, and by convention listed
      // themselves first. Everywhere else, ask.
      const creator = coders[0] ?? "";
      set({
        project,
        activeCoder: creator,
        coderConfirmed: creator !== "",
        transcriptSearch: "",
        undoStack: [],
        redoStack: [],
      });
      await get().loadCodes();
      await get().loadInterviews();
      await recordRecentFromProject(project);
      if (creator) await rememberIdentity(project.path, creator);
      set({ loading: false, openingPath: null });
      return true;
    } catch (e) {
      set({ loading: false, openingPath: null, error: String(e) });
      return false;
    }
  },

  seedCodes: async (seeds) => {
    for (const [i, seed] of seeds.entries()) {
      await api.createCode({
        name: seed.name,
        definition: seed.definition,
        color: CODE_PALETTE[i % CODE_PALETTE.length],
      });
    }
    await get().loadCodes();
  },

  requestCloseProject: async () => {
    const { hubMemoDirty, project } = get();
    if (!project) return;
    const ok = await confirmHubMemoIfDirty(hubMemoDirty);
    if (!ok) return;

    // Was: "you have not handed off this session". Handoff is gone, so the
    // question that still matters is whether this machine is holding coding
    // the other coder has never received. Best-effort — a sync status that
    // cannot be read must not block closing a project.
    try {
      const status = await api.syncStatus();
      if (status.signedIn && status.pendingChanges > 0) {
        set({ showCloseConfirm: true });
        return;
      }
    } catch {
      // Sync not set up, or no project bound. Nothing outstanding to warn about.
    }
    await get().closeProject();
  },

  closeProject: async () => {
    persistWorkspaceDebounced.cancel();
    await get().persistWorkspace();
    await api.closeProject();
    set({
      project: null,
      interviews: [],
      activeInterviewId: null,
      segments: [],
      codes: [],
      codedSegments: [],
      totalCodedCount: 0,
      interviewCodedCount: 0,
      hubMemo: "",
      savedHubMemo: "",
      hubMemoDirty: false,
      showCloseConfirm: false,
      activeCoder: "",
      coderConfirmed: false,
      showIdentityPrompt: false,
      openingPath: null,
      // Undo closures capture rows of *this* project's database; kept across
      // a close they would replay against the next project opened.
      undoStack: [],
      redoStack: [],
    });
  },

  dismissCloseConfirm: () => set({ showCloseConfirm: false }),

  confirmCloseProject: async () => {
    set({ showCloseConfirm: false });
    await get().closeProject();
  },

  requestResetWorkspace: async () => {
    const ok = await confirmHubMemoIfDirty(get().hubMemoDirty);
    if (!ok) return;
    set({ showResetConfirm: true });
  },

  dismissResetConfirm: () => set({ showResetConfirm: false }),

  confirmResetWorkspace: async (opts) => {
    set({ showResetConfirm: false });
    const { activeInterviewId, activeCoder } = get();
    try {
      const result = await api.clearWorkspace({
        interview_id: opts.scope === "active" ? activeInterviewId : null,
        clear_hub_memos: opts.clearHubMemos,
        clear_activity_log: opts.clearActivityLog,
        coder_name: activeCoder,
      });

      if (activeInterviewId) {
        await get().selectInterview(activeInterviewId, null, { persist: false });
      }
      await get().loadInterviews();
      await get().refreshCodedCount();
      await get().persistWorkspace();

      const scopeLabel = result.scope === "all" ? "all interviews" : "this interview";
      get().showStatus(
        `Reset ${scopeLabel}: ${result.cleared_coded_segments} tags removed, ${result.cleared_block_ids} block IDs cleared.`,
        "success",
      );
    } catch (e) {
      get().showStatus(String(e), "error");
    }
  },

  refreshProject: async () => {
    const project = await api.getProjectInfo();
    set({ project });
    await recordRecentFromProject(project);
  },

  setShowExportDialog: (open) => set({ showExportDialog: open }),

  requestExportProject: async () => {
    const ok = await confirmHubMemoIfDirty(get().hubMemoDirty);
    if (!ok) return;
    set({ showExportDialog: true });
  },

  exportWithConfig: async (targetDir: string, config: ExportConfig) => {
    const { project, codes, interviews, codedSegments, activeCoder, syncConflicts } = get();
    if (!project) return null;

    set({ exporting: true });
    try {
      const exportedAt = new Date().toISOString();
      const needsHtml =
        config.items.includes("report-html") ||
        config.items.includes("report-pdf");
      const reportHtml = needsHtml
        ? generateHtmlReport({
            project,
            config,
            codes,
            interviews,
            codedSegments,
            exportedBy: activeCoder,
            exportedAt,
            unresolvedConflictCount: syncConflicts.length,
          })
        : null;

      const activeInterviews =
        config.includeParticipantScope === "selected" && config.selectedParticipantIds
          ? interviews.filter((iv) => config.selectedParticipantIds?.includes(iv.id))
          : interviews;

      let activeSegments = codedSegments.filter((cs) =>
        activeInterviews.some((iv) => iv.id === cs.interview_id),
      );
      if (config.includeCoderScope === "active-coder" && activeCoder) {
        activeSegments = activeSegments.filter((cs) => cs.coder_name === activeCoder);
      }

      const frameworkMatrixCsv = config.items.includes("framework-matrix")
        ? generateFrameworkMatrixCsv(
            buildFrameworkMatrix(codes, activeInterviews, activeSegments),
          )
        : null;

      const result = await api.exportWithConfig(
        targetDir,
        config,
        reportHtml,
        frameworkMatrixCsv,
        activeCoder,
      );

      const folderName = result.exports_dir.split("/").pop() || "export folder";
      get().showStatus(
        `Exported ${result.files.length} ${result.files.length === 1 ? "file" : "files"} to ${folderName}`,
        "success",
        {
          label: `Reveal in ${fileManagerName}`,
          onClick: () => {
            void revealItemInDir(result.exports_dir);
          },
        },
      );

      return result;
    } catch (e) {
      get().showStatus(String(e), "error");
      return null;
    } finally {
      set({ exporting: false });
    }
  },

  setShowActivityLog: (open) => set({ showActivityLog: open }),

  setShowProjectFiles: (open) => set({ showProjectFiles: open }),

  setShowBackups: (open) => set({ showBackups: open }),

  setPendingSelection: (selection) => {
    // Selecting inside a passage also makes it the active one, so the right
    // rail and the transcript are never describing different passages.
    if (selection) set({ selectedSegmentId: selection.segmentId, selectionIntent: "click" });
    set({ pendingSelection: selection });

    // The ticks describe whatever is being coded, and that just changed: a
    // fresh span carries no codes even when the turn around it is fully coded.
    // Without this the codebook would show the turn's codes while a tick would
    // write against the span, which is the same lie the two-step Apply told.
    const target = get().currentCodingTarget();
    set({
      selectedCodeIds: target?.existing?.code_ids ?? [],
    });
  },

  setCodeFilter: (codeId) => set({ codeFilter: codeId }),

  /**
   * Swap the project for one of its snapshots, then reload from disk.
   *
   * Every id in the store — selected segment, active interview, the codebook —
   * belongs to the database that was just replaced, so this rehydrates from
   * scratch rather than merging. Anything less and the UI would keep pointing
   * at rows the restored database has never heard of.
   */
  restoreFromBackup: async (backupPath) => {
    set({ loading: true, openingPath: backupPath, error: null });
    try {
      const outcome = await api.restoreBackup(backupPath);
      const project = await api.getProjectInfo();
      await get().openProject(project.path);
      get().showStatus("Project restored from backup.");
      return outcome;
    } catch (e) {
      set({ loading: false, openingPath: null, error: String(e) });
      throw e;
    }
  },

  loadActivity: async () => api.listActivity(),

  loadCodes: async () => {
    const codes = await api.listCodes();
    set({ codes });
  },

  addCode: async (name, color, definition) => {
    const created = await api.createCode({ name, color, definition });
    const codes = [...get().codes.filter((code) => code.id !== created.id), created].sort(
      (left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name),
    );
    set({ codes });
    return created;
  },

  createCodeAndApply: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const { activeInterviewId, activeCoder, coderConfirmed } = get();
    const target = get().currentCodingTarget();
    if (!activeInterviewId || !target) {
      get().showStatus("Click a passage in the transcript first.", "info");
      return;
    }
    if (!coderConfirmed || !activeCoder) {
      get().showStatus("Choose who is coding before applying codes.", "error");
      set({ showIdentityPrompt: true });
      return;
    }

    try {
      const result = await api.ensureCodeAndApply({
        name: trimmed,
        color: nextCodeColor(get().codes.length),
        interview_id: activeInterviewId,
        segment_id: target.segmentId,
        coder_name: activeCoder,
        char_start: target.span?.start,
        char_end: target.span?.end,
      });
      const codes = [
        ...get().codes.filter((code) => code.id !== result.code.id),
        result.code,
      ].sort(
        (left, right) =>
          left.sort_order - right.sort_order || left.name.localeCompare(right.name),
      );
      set({ codes, recentCodeIds: pushRecentCode(get().recentCodeIds, result.code.id) });
      reconcileCodingTarget(
        get,
        set,
        {
          interviewId: activeInterviewId,
          segmentId: target.segmentId,
          coderName: activeCoder,
          span: target.span,
        },
        result.coded_segment,
      );
    } catch (e) {
      get().showStatus("Could not create and apply code: " + String(e), "error");
    }
  },

  updateCode: async (input) => {
    await api.updateCode({
      id: input.id,
      name: input.name,
      definition: input.definition ?? null,
      inclusion_criteria: input.inclusion_criteria ?? null,
      exclusion_criteria: input.exclusion_criteria ?? null,
      example: input.example ?? null,
      parent_id: input.parent_id ?? null,
      color: input.color,
    });
    await get().loadCodes();
    const { activeInterviewId } = get();
    if (activeInterviewId) await get().loadCodedSegments();
  },

  reparentCode: async (codeId, newParentId) => {
    const code = get().codes.find((c) => c.id === codeId);
    if (!code) return;
    const previousParentId = code.parent_id ?? null;
    if (previousParentId === (newParentId ?? null)) return;

    const parentCode = newParentId ? get().codes.find((c) => c.id === newParentId) : null;
    const label = newParentId && parentCode
      ? `Nest "${code.name}" under "${parentCode.name}"`
      : `Promote "${code.name}" to top level`;

    await api.updateCode({
      id: code.id,
      name: code.name,
      definition: code.definition ?? null,
      inclusion_criteria: code.inclusion_criteria ?? null,
      exclusion_criteria: code.exclusion_criteria ?? null,
      example: code.example ?? null,
      parent_id: newParentId ?? null,
      color: code.color,
    });
    await get().loadCodes();

    get().pushUndo(
      label,
      async () => {
        const current = get().codes.find((c) => c.id === codeId) ?? code;
        await api.updateCode({
          id: current.id,
          name: current.name,
          definition: current.definition ?? null,
          inclusion_criteria: current.inclusion_criteria ?? null,
          exclusion_criteria: current.exclusion_criteria ?? null,
          example: current.example ?? null,
          parent_id: previousParentId,
          color: current.color,
        });
        await get().loadCodes();
      },
      async () => {
        const current = get().codes.find((c) => c.id === codeId) ?? code;
        await api.updateCode({
          id: current.id,
          name: current.name,
          definition: current.definition ?? null,
          inclusion_criteria: current.inclusion_criteria ?? null,
          exclusion_criteria: current.exclusion_criteria ?? null,
          example: current.example ?? null,
          parent_id: newParentId ?? null,
          color: current.color,
        });
        await get().loadCodes();
      },
    );
  },

  deleteCode: async (codeId, mode) => {
    const { activeCoder, activeInterviewId, selectedCodeIds } = get();
    try {
      const result = await api.deleteCode(codeId, mode, activeCoder);
      set({
        selectedCodeIds: selectedCodeIds.filter((id) => id !== codeId),
        recentCodeIds: get().recentCodeIds.filter((id) => id !== codeId),
      });
      await get().loadCodes();
      if (activeInterviewId) {
        await get().selectInterview(activeInterviewId, get().selectedSegmentId, {
          persist: false,
        });
      }
      await get().refreshCodedCount();

      get().showStatus(
        result.mode === "retire"
          ? `Retired "${result.code_name}". Existing coding keeps the label.`
          : result.segments_updated > 0
            ? `Deleted "${result.code_name}" from ${result.segments_updated} passage(s).`
            : `Deleted "${result.code_name}".`,
      );
    } catch (e) {
      get().showStatus(String(e), "error");
    }
  },

  restoreCode: async (codeId) => {
    try {
      await api.restoreCode(codeId);
      await get().loadCodes();
      get().showStatus("Code restored to the codebook.");
    } catch (e) {
      get().showStatus(String(e), "error");
    }
  },

  loadRetiredCodes: async () => api.listRetiredCodes(),

  removeCodedSegment: async (codedSegmentId) => {
    const { codedSegments } = get();
    const removed = codedSegments.find((c) => c.id === codedSegmentId);
    if (!removed) return;
    const span =
      removed.char_start != null && removed.char_end != null
        ? { start: removed.char_start, end: removed.char_end }
        : null;
    const target = {
      interviewId: removed.interview_id,
      segmentId: removed.segment_id,
      coderName: removed.coder_name,
      span,
    };
    const removeEdges = async () => {
      for (const codeId of removed.code_ids) {
        await mutateCodingEdgeOnTarget(get, set, { ...target, codeId, present: false });
      }
    };
    const restoreEdges = async () => {
      let restored: CodedSegment | null = null;
      for (const codeId of removed.code_ids) {
        const result = await mutateCodingEdgeOnTarget(get, set, {
          ...target,
          codeId,
          present: true,
        });
        restored = result.coded_segment ?? restored;
      }
      if (restored && removed.memo) {
        const patched = await api.patchCodingMemo({
          coded_segment_id: restored.id,
          memo: removed.memo,
        });
        reconcilePatchedCoding(get, set, patched);
      }
    };
    try {
      await removeEdges();
      get().pushUndo(
        removed.coder_name === get().activeCoder
          ? "Removed your coding"
          : `Removed ${removed.coder_name}'s coding`,
        restoreEdges,
        removeEdges,
      );

      get().showStatus("Coding removed from this passage.", "success", {
        label: "Undo",
        onClick: () => void get().undoLastCoding(),
      });
    } catch (e) {
      get().showStatus(String(e), "error");
    }
  },

  removeCodeFromCoding: async (codingId: string, codeId: string) => {
    const { codedSegments } = get();
    const coding = codedSegments.find((c) => c.id === codingId);
    if (!coding) return;

    const codeName = get().codes.find((c) => c.id === codeId)?.name ?? "code";
    const span =
      coding.char_start != null && coding.char_end != null
        ? { start: coding.char_start, end: coding.char_end }
        : null;
    const target = {
      interviewId: coding.interview_id,
      segmentId: coding.segment_id,
      coderName: coding.coder_name,
      span,
      codeId,
    };

    try {
      await mutateCodingEdgeOnTarget(get, set, { ...target, present: false });

      get().pushUndo(
        `Removed "${codeName}"`,
        async () => {
          await mutateCodingEdgeOnTarget(get, set, { ...target, present: true });
        },
        async () => {
          await mutateCodingEdgeOnTarget(get, set, { ...target, present: false });
        },
      );

      get().showStatus(`Removed "${codeName}"`, "info", {
        label: "Undo",
        onClick: () => {
          void get().undoLastCoding();
        },
      });
    } catch (e) {
      get().showStatus("Could not remove code: " + String(e), "error");
    }
  },

  clearMemoForCoding: async (codingId: string) => {
    const { codedSegments } = get();
    const coding = codedSegments.find((c) => c.id === codingId);
    if (!coding || !coding.memo) return;

    const previousMemo = coding.memo;
    try {
      const cleared = await api.patchCodingMemo({
        coded_segment_id: coding.id,
        memo: undefined,
      });
      reconcilePatchedCoding(get, set, cleared);

      get().pushUndo(
        "Removed note",
        async () => {
          const restored = await api.patchCodingMemo({
            coded_segment_id: coding.id,
            memo: previousMemo,
          });
          reconcilePatchedCoding(get, set, restored);
        },
        async () => {
          const clearedAgain = await api.patchCodingMemo({
            coded_segment_id: coding.id,
            memo: undefined,
          });
          reconcilePatchedCoding(get, set, clearedAgain);
        },
      );

      get().showStatus("Note removed", "info", {
        label: "Undo",
        onClick: () => {
          void get().undoLastCoding();
        },
      });
    } catch (e) {
      get().showStatus("Could not remove note: " + String(e), "error");
    }
  },

  loadInterviews: async () => {
    const interviews = await api.listInterviews();
    set({ interviews });
  },

  renameInterview: async (id, label, date) => {
    try {
      await api.updateInterview({
        id,
        participant_label: label,
        interview_date: date ?? null,
      });
      await get().loadInterviews();
      get().showStatus(`Interview renamed to "${label}".`);
    } catch (e) {
      get().showStatus(String(e), "error");
    }
  },

  interviewDeleteImpact: async (id) => api.interviewDeleteImpact(id),

  deleteInterview: async (id) => {
    const { activeCoder, activeInterviewId } = get();
    try {
      await api.deleteInterview(id, activeCoder);
      await get().loadInterviews();

      if (activeInterviewId === id) {
        // The open interview just went away — land on another one rather than
        // leaving the workspace pointing at a deleted id.
        const next = get().interviews[0];
        if (next) {
          await get().selectInterview(next.id);
        } else {
          set({
            activeInterviewId: null,
            segments: [],
            codedSegments: [],
            interviewCodedCount: 0,
            selectedSegmentId: null,
            selectedCodeIds: [],
            hubMemo: "",
            savedHubMemo: "",
            hubMemoDirty: false,
          });
          await get().persistWorkspace();
        }
      }
      await get().refreshCodedCount();
      get().showStatus("Interview deleted.");
    } catch (e) {
      get().showStatus(String(e), "error");
    }
  },

  refreshCodedCount: async () => {
    const allCoded = await api.listCodedSegments();
    set({ totalCodedCount: allCoded.length });
  },

  persistWorkspace: async () => {
    const { activeInterviewId, selectedSegmentId, activeCoder, project } = get();
    if (!project) return;
    await api.saveWorkspaceState({
      active_interview_id: activeInterviewId,
      selected_segment_id: selectedSegmentId,
      active_coder: activeCoder,
    });
  },

  restoreWorkspace: async () => {
    const interviews = get().interviews;
    if (interviews.length === 0) {
      set({ interviewCodedCount: 0 });
      await get().refreshCodedCount();
      return;
    }

    const ws = await api.getWorkspaceState();
    const project = get().project;

    let interviewId = ws.active_interview_id;
    if (!interviewId || !interviews.some((i) => i.id === interviewId)) {
      interviewId =
        interviews.find((i) => i.segment_count > 0)?.id ?? interviews[0]?.id ?? null;
    }

    // `ws.active_coder` came out of the project file, so it names whoever last
    // used *that copy* — quite possibly a teammate on another Mac. Restoring it
    // is how a project remembers your seat; it is not evidence of who is
    // sitting in it now. When identity is still unconfirmed, leave it alone and
    // let the "Who's coding?" prompt settle it.
    if (get().coderConfirmed) {
      let coder = ws.active_coder ?? project?.last_saved_by ?? get().activeCoder;
      if (project?.coders.length && !project.coders.includes(coder)) {
        coder = project.coders[0] ?? coder;
      }
      set({ activeCoder: coder });
    }

    if (interviewId) {
      await get().selectInterview(interviewId, ws.selected_segment_id, {
        persist: false,
      });
    }

    await get().persistWorkspace();
    await get().refreshCodedCount();
  },

  selectInterview: async (id, preferredSegmentId, options) => {
    const interview = get().interviews.find((i) => i.id === id);
    const segments = await api.getSegments(id);
    const codedSegments = await api.listCodedSegments(id);

    let selectedSegmentId = segments[0]?.id ?? null;
    if (
      preferredSegmentId &&
      segments.some((segment) => segment.id === preferredSegmentId)
    ) {
      selectedSegmentId = preferredSegmentId;
    }

    const { activeCoder } = get();
    let selectedCodeIds: string[] = [];
    if (selectedSegmentId && activeCoder) {
      const existing = codedSegments.find(
        (c) =>
          c.segment_id === selectedSegmentId &&
          c.coder_name === activeCoder &&
          c.char_start == null &&
          c.char_end == null,
      );
      if (existing) {
        selectedCodeIds = [...existing.code_ids];
      }
    }

    const hub = interview?.hub_memo ?? "";
    set({
      activeInterviewId: id,
      segments,
      codedSegments,
      interviewCodedCount: computeInterviewCodedCount(codedSegments),
      hubMemo: hub,
      savedHubMemo: hub,
      hubMemoDirty: false,
      selectedSegmentId,
      selectedCodeIds,
      selectionIntent: options?.persist === false ? "restore" : "jump",
    });

    if (options?.persist !== false) {
      await get().persistWorkspace();
    }
  },

  selectAdjacentSegment: (direction) => {
    const { segments, selectedSegmentId } = get();
    if (segments.length === 0) return;
    const idx = segments.findIndex((s) => s.id === selectedSegmentId);
    const nextIdx =
      direction === "next"
        ? Math.min(idx < 0 ? 0 : idx + 1, segments.length - 1)
        : Math.max(idx < 0 ? 0 : idx - 1, 0);
    get().setSelectedSegmentId(segments[nextIdx].id, "keys");
  },

  createInterview: async (label, date) => {
    const interview = await api.createInterview({
      participant_label: label,
      interview_date: date,
      interviewers: [],
    });
    await get().loadInterviews();
    await get().selectInterview(interview.id);
    return interview;
  },

  importVtt: async (vttPath) => {
    const { activeInterviewId, codedSegments } = get();
    const mergeSameSpeaker =
      useAppStore.getState().preferences.merge_same_speaker;
    if (!activeInterviewId) throw new Error("No interview selected");

    if (codedSegments.length > 0) {
      const ok = await confirm(
        `This interview has ${codedSegments.length} coded passage(s). Coding on passages whose wording is unchanged will be kept; coding on passages that changed or were removed will go with them. Continue?`,
        { title: "Re-import transcript", kind: "warning" },
      );
      if (!ok) {
        get().showStatus("Import cancelled.", "info");
        return 0;
      }
    }

    const raw = await api.readTranscriptFile(vttPath);
    const { segments, format } = await parseTranscriptFile(
      raw,
      mergeSameSpeaker,
      vttPath,
    );

    if (segments.length === 0) {
      throw new Error(
        "No speaker turns could be read from that file. If it is a transcript, " +
          "check that it has speaker labels or timestamps.",
      );
    }

    const count = await api.importSegments({
      interview_id: activeInterviewId,
      segments,
      raw_vtt_path: vttPath,
    });

    get().showStatus(
      `Imported ${count} passage(s) from ${FORMAT_LABELS[format]}.`,
      "success",
    );

    await get().selectInterview(activeInterviewId);
    await get().loadInterviews();
    await get().refreshCodedCount();
    return count;
  },

  loadCodedSegments: async (codeId) => {
    const { activeInterviewId } = get();
    const codedSegments = await api.listCodedSegments(
      activeInterviewId ?? undefined,
      codeId,
    );
    set({
      codedSegments,
      interviewCodedCount: computeInterviewCodedCount(codedSegments),
    });
  },

  saveHubMemo: async (options) => {
    const { activeInterviewId, hubMemo } = get();
    if (!activeInterviewId) return;
    // ⚠️ This had no catch. That was survivable while the only caller was a
    // button the user had just pressed; autosave calls it unattended, where an
    // unhandled rejection is a memo silently not saved under a panel that says
    // it was.
    try {
      await api.updateHubMemo(activeInterviewId, hubMemo);
      await get().loadInterviews();
      set({ savedHubMemo: hubMemo, hubMemoDirty: false });
      if (!options?.silent) {
        get().showStatus("Hub memo saved for this interview.");
      }
    } catch (e) {
      get().showStatus("Could not save the memo: " + String(e), "error");
    }
  },
}));

if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).useProjectStore = useProjectStore;
}
