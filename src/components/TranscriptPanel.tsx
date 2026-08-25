import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../store/project-store";
import { useAppStore } from "../store/app-store";
import { formatTimestampDisplay } from "../lib/vtt-parser";
import { basename } from "../lib/format";
import { NewInterviewModal } from "./NewInterviewModal";
import { InterviewSettingsModal } from "./InterviewSettingsModal";
import { TranscriptLinkPanel } from "./TranscriptLinkPanel";
import { api } from "../lib/api";
import {
  highlightRuns,
  selectionOffsets,
  formatRunAttribution,
  type HighlightRun,
} from "../lib/highlight";
import { SelectionBubble, type BubbleAnchor } from "./SelectionBubble";
import { CodeFilterButton } from "./CodeFilterButton";
import { buildMarkMenuItems } from "./TranscriptPanel.menu";
import { NoteEditor } from "./NoteEditor";
import { THEME_GROUND, usePrefersDark } from "../hooks/useTheme";
import { computeStripeLayout, type StripeLayoutResult } from "../lib/stripe-layout";
import { Icon } from "./ui/Icon";
import { Tooltip } from "./ui/Tooltip";
import { openContextMenu } from "./ui/ContextMenu";
import { readableOn } from "../lib/code-colors";
import { scrollPlan } from "../lib/scroll-into-view";
import type { Code, CodedSegment, Interview, TranscriptSegment } from "../lib/types";

export function TranscriptPanel() {
  const {
    segments,
    selectedSegmentId,
    setSelectedSegmentId,
    selectionIntent,
    codedSegments,
    codes,
    activeInterviewId,
    interviews,
    importVtt,
    createInterview,
    selectInterview,
    transcriptSearch,
    setTranscriptSearch,
    renameInterview,
    deleteInterview,
    interviewDeleteImpact,
    activeCoder,
    removeCodedSegment,
    showStatus,
    saveMemoForCoding,
    openNoteForCoding,
    removeCodeFromCoding,
    clearMemoForCoding,
    setPendingSelection,
    pendingSpan,
    codeFilter,
    setCodeFilter,
  } = useProjectStore(
    useShallow((s) => ({
      segments: s.segments,
      selectedSegmentId: s.selectedSegmentId,
      setSelectedSegmentId: s.setSelectedSegmentId,
      selectionIntent: s.selectionIntent,
      codedSegments: s.codedSegments,
      codes: s.codes,
      activeInterviewId: s.activeInterviewId,
      interviews: s.interviews,
      importVtt: s.importVtt,
      createInterview: s.createInterview,
      selectInterview: s.selectInterview,
      transcriptSearch: s.transcriptSearch,
      setTranscriptSearch: s.setTranscriptSearch,
      renameInterview: s.renameInterview,
      deleteInterview: s.deleteInterview,
      interviewDeleteImpact: s.interviewDeleteImpact,
      activeCoder: s.activeCoder,
      removeCodedSegment: s.removeCodedSegment,
      showStatus: s.showStatus,
      saveMemoForCoding: s.saveMemoForCoding,
      openNoteForCoding: s.openNoteForCoding,
      removeCodeFromCoding: s.removeCodeFromCoding,
      clearMemoForCoding: s.clearMemoForCoding,
      setPendingSelection: s.setPendingSelection,
      pendingSpan: s.pendingSelection,
      codeFilter: s.codeFilter,
      setCodeFilter: s.setCodeFilter,
    })),
  );
  const intent = useAppStore((s) => s.intent);
  const setIntent = useAppStore((s) => s.setIntent);

  const [importing, setImporting] = useState(false);
  const [showNewInterview, setShowNewInterview] = useState(false);
  const [showLinkPanel, setShowLinkPanel] = useState(false);
  const [pendingCoded, setPendingCoded] = useState(0);
  const [editingInterview, setEditingInterview] = useState<Interview | null>(null);
  const [showNotes, setShowNotes] = useState(true);
  const articleRefs = useRef<Map<string, HTMLElement>>(new Map());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [bubbleAnchor, setBubbleAnchor] = useState<BubbleAnchor | null>(null);

  /**
   * Span capture lives at the document level.
   * Cross-passage selection triggers a helpful notice (B4).
   */
  useEffect(() => {
    const onMouseUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const node =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      const article = node?.closest('[role="option"]');
      const p = article?.querySelector("p");

      if (!article || !p) {
        // Check if drag crossed passages inside transcript listbox (B4)
        const inTranscript = node?.closest('[role="listbox"]');
        if (inTranscript) {
          showStatus("A coded span has to sit inside one speaker turn.", "info");
        }
        return;
      }

      const segmentId = article.id.replace(/^segment-/, "");
      const offsets = selectionOffsets(p);
      if (!offsets) return;

      const box = p.getBoundingClientRect();
      const r = range.getBoundingClientRect();
      setPendingSelection({ segmentId, ...offsets });
      setBubbleAnchor({
        segmentId,
        rel: {
          top: r.top - box.top,
          left: r.left - box.left,
          bottom: r.bottom - box.top,
        },
      });
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, [setPendingSelection, showStatus]);

  useEffect(() => {
    if (bubbleAnchor && bubbleAnchor.segmentId !== selectedSegmentId) {
      setBubbleAnchor(null);
      setPendingSelection(null);
    }
  }, [selectedSegmentId, bubbleAnchor, setPendingSelection]);

  useEffect(() => {
    if (!selectedSegmentId) return;
    const el = articleRefs.current.get(selectedSegmentId);
    const scroller = scrollerRef.current;
    if (!el || !scroller) return;

    const elRect = el.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const elTop = scroller.scrollTop + (elRect.top - scrollerRect.top);
    const elHeight = elRect.height;
    const viewportHeight = scrollerRect.height;

    const targetScrollTop = scrollPlan({
      elTop,
      elHeight,
      scrollTop: scroller.scrollTop,
      viewportHeight,
      intent: selectionIntent,
    });

    if (targetScrollTop === null) return;

    if (selectionIntent === "restore") {
      scroller.scrollTop = targetScrollTop;
    } else {
      scroller.scrollTo({ top: targetScrollTop, behavior: "smooth" });
    }
  }, [selectedSegmentId, selectionIntent]);

  useEffect(() => {
    let live = true;
    api
      .pendingCodedCount()
      .then((n) => live && setPendingCoded(n))
      .catch(() => live && setPendingCoded(0));
    return () => {
      live = false;
    };
  }, [segments.length, activeInterviewId]);

  const activeInterview = interviews.find((i) => i.id === activeInterviewId);

  async function pickVttAndImport(targetInterviewId?: string) {
    if (targetInterviewId && targetInterviewId !== activeInterviewId) {
      await selectInterview(targetInterviewId);
    }
    const file = await open({
      multiple: false,
      filters: [
        {
          name: "Transcripts",
          extensions: ["vtt", "srt", "txt", "md", "csv", "tsv", "docx"],
        },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!file || typeof file !== "string") return;
    setImporting(true);
    try {
      const count = await importVtt(file);
      showStatus(
        `Imported ${count} turns from ${basename(file)}.`,
        "success",
      );
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setImporting(false);
    }
  }

  async function handleImportVtt() {
    const interviewId = useProjectStore.getState().activeInterviewId;
    if (!interviewId) {
      setShowNewInterview(true);
      return;
    }
    await pickVttAndImport(interviewId);
  }

  const importRef = useRef(handleImportVtt);
  importRef.current = handleImportVtt;
  useEffect(() => {
    if (intent === "import-vtt") {
      setIntent(null);
      importRef.current();
    } else if (intent === "new-interview") {
      setIntent(null);
      setShowNewInterview(true);
    }
  }, [intent, setIntent]);

  async function handleNewInterviewConfirm(label: string) {
    setShowNewInterview(false);
    setImporting(true);
    try {
      const interview = await createInterview(
        label,
        new Date().toISOString().slice(0, 10),
      );
      await pickVttAndImport(interview.id);
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), "error");
      setImporting(false);
    }
  }

  const codedBySegment = new Map<string, typeof codedSegments>();
  for (const c of codedSegments) {
    const list = codedBySegment.get(c.segment_id);
    if (list) list.push(c);
    else codedBySegment.set(c.segment_id, [c]);
  }
  const codesById = new Map(codes.map((c) => [c.id, c]));

  const search = transcriptSearch.trim().toLowerCase();
  const visibleSegments = segments.filter((seg) => {
    if (codeFilter) {
      const here = codedBySegment.get(seg.id);
      if (!here?.some((c) => c.code_ids.includes(codeFilter))) return false;
    }
    if (!search) return true;
    return (
      seg.text.toLowerCase().includes(search) ||
      seg.speaker.toLowerCase().includes(search)
    );
  });

  const clearPassageSelection = () => {
    setPendingSelection(null);
    setSelectedSegmentId(null);
    setBubbleAnchor(null);
    window.getSelection()?.removeAllRanges();
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    const ids = visibleSegments.map((seg) => seg.id);
    if (ids.length === 0) return;
    const current = selectedSegmentId ? ids.indexOf(selectedSegmentId) : -1;

    const go = (to: number) => {
      e.preventDefault();
      const id = ids[Math.max(0, Math.min(ids.length - 1, to))];
      setSelectedSegmentId(id, "keys");
      articleRefs.current.get(id)?.focus({ preventScroll: true });
    };

    if (e.key === "Escape") {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      clearPassageSelection();
      return;
    }

    // N / Shift+N jump between uncoded passages (B8)
    if (
      (e.key === "n" || e.key === "N") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      const isUncoded = (segId: string) => {
        const codings = codedBySegment.get(segId);
        return !codings || codings.length === 0;
      };

      if (e.shiftKey) {
        let foundIdx = -1;
        const start = current < 0 ? ids.length - 1 : current - 1;
        for (let i = start; i >= 0; i--) {
          if (isUncoded(ids[i])) {
            foundIdx = i;
            break;
          }
        }
        if (foundIdx >= 0) go(foundIdx);
        else showStatus("No previous uncoded passages.", "info");
      } else {
        let foundIdx = -1;
        const start = current < 0 ? 0 : current + 1;
        for (let i = start; i < ids.length; i++) {
          if (isUncoded(ids[i])) {
            foundIdx = i;
            break;
          }
        }
        if (foundIdx >= 0) go(foundIdx);
        else showStatus("No more uncoded passages in this interview.", "info");
      }
      return;
    }

    if (
      (e.key === "c" || e.key === "C") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      selectedSegmentId
    ) {
      e.preventDefault();
      setPendingSelection(null);
      setBubbleAnchor({ segmentId: selectedSegmentId, rel: null });
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        return go(current < 0 ? 0 : current + 1);
      case "ArrowUp":
        return go(current < 0 ? ids.length - 1 : current - 1);
      case "Home":
        return go(0);
      case "End":
        return go(ids.length - 1);
      case "PageDown":
        return go(Math.min(ids.length - 1, current + 5));
      case "PageUp":
        return go(Math.max(0, current - 5));
    }
  };

  async function copyText(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      showStatus(`Copied ${what.toLowerCase()} to clipboard.`);
    } catch {
      showStatus("Could not reach the clipboard.", "error");
    }
  }

  function segmentMenu(seg: TranscriptSegment) {
    const mine = codedSegments.find(
      (c) => c.segment_id === seg.id && c.coder_name === activeCoder,
    );
    return [
      {
        label: "Code this passage…",
        icon: "code" as const,
        onSelect: () => {
          setPendingSelection(null);
          setBubbleAnchor({ segmentId: seg.id, rel: null });
        },
      },
      {
        label: "Copy passage",
        icon: "note" as const,
        onSelect: () => copyText(seg.text, "Passage"),
      },
      {
        label: "Copy with speaker and timestamp",
        icon: "export" as const,
        onSelect: () =>
          copyText(
            `${seg.speaker} (${formatTimestampDisplay(seg.timestamp_start)}): ${seg.text}`,
            "Passage",
          ),
      },
      ...(seg.block_id
        ? [
            {
              label: `Copy block ID ^${seg.block_id}`,
              icon: "code" as const,
              onSelect: () => copyText(`^${seg.block_id}`, "Block ID"),
            },
          ]
        : []),
      ...(mine
        ? [
            {
              label: "Remove my coding here",
              icon: "close" as const,
              onSelect: () => removeCodedSegment(mine.id),
              destructive: true,
            },
          ]
        : []),
    ];
  }

  function interviewOverflowMenu(interview: Interview) {
    const isSingle = interviews.length <= 1;
    return [
      {
        label: "Edit details…",
        icon: "settings" as const,
        onSelect: () => setEditingInterview(interview),
      },
      {
        label: "Replace transcript…",
        icon: "import" as const,
        onSelect: () => pickVttAndImport(interview.id),
      },
      {
        label: isSingle ? "Delete interview (only one left)" : "Delete interview…",
        icon: "trash" as const,
        destructive: true,
        disabled: isSingle,
        onSelect: async () => {
          const impact = await interviewDeleteImpact(interview.id);
          const parts: string[] = [];
          if (impact.segment_count > 0)
            parts.push(`${impact.segment_count} passages`);
          if (impact.coded_segment_count > 0)
            parts.push(`${impact.coded_segment_count} coded`);
          if (impact.has_hub_memo) parts.push("analytic memo");
          const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
          const ok = window.confirm(
            `Delete "${interview.participant_label}"${summary}? This cannot be undone.`,
          );
          if (ok) {
            await deleteInterview(interview.id);
            showStatus(`Deleted "${interview.participant_label}".`);
          }
        },
      },
    ];
  }

  const dark = usePrefersDark();
  const ground = dark ? THEME_GROUND.dark : THEME_GROUND.light;
  const filteredCode = codes.find((c) => c.id === codeFilter) ?? null;
  const noteCount = codedSegments.filter((c) => c.memo?.trim()).length;

  const passageCodings = (segId: string) => {
    return codedBySegment.get(segId) ?? [];
  };

  return (
    <main
      data-testid="transcript-panel"
      className="@container glass-panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {/* Header bar */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--g-rim)] px-4">
        {interviews.length > 0 ? (
          <>
            <select
              value={activeInterviewId ?? ""}
              onChange={(e) => selectInterview(e.target.value)}
              aria-label="Current interview"
              className="field field-sm min-w-0 max-w-[200px] truncate text-[13px] font-medium @2xl:max-w-none"
            >
              {interviews.map((iv) => (
                <option key={iv.id} value={iv.id}>
                  {iv.participant_label}
                  {iv.segment_count === 0 ? " (no transcript)" : ""}
                </option>
              ))}
            </select>

            {activeInterview && (
              <button
                type="button"
                onClick={(e) =>
                  openContextMenu(e, interviewOverflowMenu(activeInterview))
                }
                aria-label={`Interview actions for ${activeInterview.participant_label}`}
                title="Interview actions"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[var(--ink-3)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)]"
              >
                <Icon name="dots" size={14} />
              </button>
            )}
          </>
        ) : (
          <span className="hint">No interviews yet</span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Code Filter Button (A6) */}
          <CodeFilterButton />

          {noteCount > 0 && (
            <Tooltip content={showNotes ? "Hide passage notes" : "Show passage notes"}>
              <button
                type="button"
                aria-pressed={showNotes}
                aria-label={showNotes ? "Hide passage notes" : "Show passage notes"}
                onClick={() => setShowNotes((visible) => !visible)}
                className="btn btn-ghost btn-sm"
              >
                <Icon name="note" size={13} />
                <span className="hidden @2xl:inline">
                  {showNotes ? "Notes" : "Notes hidden"}
                </span>
              </button>
            </Tooltip>
          )}

          {segments.length > 0 && (
            <label className="relative flex items-center">
              <Icon
                name="search"
                size={13}
                className="pointer-events-none absolute left-2.5 opacity-45"
              />
              <input
                type="search"
                value={transcriptSearch}
                onChange={(e) => setTranscriptSearch(e.target.value)}
                placeholder="Search"
                aria-label="Search transcript"
                className="field field-sm w-24 pl-7 @2xl:w-36"
              />
            </label>
          )}
        </div>
      </div>

      {segments.length === 0 ? (
        <EmptyTranscript
          importing={importing}
          onImport={handleImportVtt}
          onScanFolder={() => setShowLinkPanel(true)}
          hasInterview={interviews.length > 0}
          awaitedPassages={
            interviews.find((i) => i.id === activeInterviewId)
              ?.remote_segment_count ?? null
          }
          pendingCoded={pendingCoded}
        />
      ) : (
        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          {/* Main Transcript Scroller */}
          <div
            ref={scrollerRef}
            data-testid="transcript-scroller"
            className="scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-6 pb-24 pt-1"
            onMouseDown={(e) => {
              if (!(e.target instanceof HTMLElement)) return;
              if (e.target.closest('[role="option"]')) return;
              clearPassageSelection();
            }}
          >
            <div className="reading-page mx-auto max-w-xl px-2 pb-2">
              {(search || filteredCode) && (
                <div className="glass-bar sticky top-0 z-10 -mx-2 flex items-center gap-2 rounded-b-[12px] px-2 py-2">
                  {search && (
                    <span className="hint text-[11.5px]">
                      {visibleSegments.length} of {segments.length} match “{search}”
                    </span>
                  )}
                  {filteredCode && (
                    <button
                      type="button"
                      onClick={() => setCodeFilter(null)}
                      className="chip"
                      style={{
                        background: `${filteredCode.color}22`,
                        color: readableOn(filteredCode.color, ground),
                      }}
                      title="Show the whole transcript again"
                    >
                      <Icon name="filter" size={11} />
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: readableOn(filteredCode.color, ground) }}
                      />
                      {visibleSegments.length} coded “{filteredCode.name}”
                      <Icon name="close" size={11} />
                    </button>
                  )}
                </div>
              )}

              <div
                role="listbox"
                aria-label="Transcript passages"
                aria-activedescendant={
                  selectedSegmentId ? `segment-${selectedSegmentId}` : undefined
                }
                onKeyDown={onListKeyDown}
                className="flex flex-col gap-1 outline-none"
              >
                {visibleSegments.map((seg) => {
                  const isSelected = seg.id === selectedSegmentId;
                  const segCodings = passageCodings(seg.id);
                  const isCoded = segCodings.length > 0;
                  return (
                    <article
                      key={seg.id}
                      ref={(el) => {
                        if (el) articleRefs.current.set(seg.id, el);
                        else articleRefs.current.delete(seg.id);
                      }}
                      id={`segment-${seg.id}`}
                      role="option"
                      aria-label={`Passage ${seg.segment_index + 1}${isCoded ? "" : " — Not yet coded"}: ${seg.speaker}`}
                      aria-selected={isSelected}
                      tabIndex={isSelected ? 0 : -1}
                      onClick={(e) => {
                        setSelectedSegmentId(seg.id, "click");
                        if (window.getSelection()?.isCollapsed !== false) {
                          const article = e.currentTarget;
                          requestAnimationFrame(() => article.focus({ preventScroll: true }));
                        }
                      }}
                      onFocus={() => {
                        if (selectedSegmentId !== seg.id) {
                          setSelectedSegmentId(seg.id, "click");
                        }
                      }}
                      onContextMenu={(e) => {
                        setSelectedSegmentId(seg.id, "click");
                        openContextMenu(e, segmentMenu(seg));
                      }}
                      className="rounded-[14px] px-4 py-3 transition-all"
                      style={{
                        background: isSelected ? "var(--fill-on)" : "transparent",
                        boxShadow: isSelected
                          ? "var(--shadow-1), inset 3px 0 0 0 var(--accent), inset 0 0 0 1px var(--accent)"
                          : "none",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected)
                          e.currentTarget.style.background = "var(--fill)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected)
                          e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <header className="mb-1.5 flex items-center gap-2 text-[11px]">
                        <span
                          className="shrink-0 font-mono tabular-nums"
                          style={{ color: "var(--ink-4)" }}
                          aria-label={`Passage ${seg.segment_index + 1}`}
                        >
                          {seg.segment_index + 1}
                        </span>
                        <span
                          className="font-medium"
                          style={{
                            color:
                              seg.speaker === "Interviewer"
                                ? "var(--ink-3)"
                                : "var(--ink)",
                          }}
                        >
                          {seg.speaker}
                        </span>
                        <span className="font-mono text-[10.5px] tabular-nums" style={{ color: "var(--ink-4)" }}>
                          {formatTimestampDisplay(seg.timestamp_start)}
                        </span>
                        {isCoded && (
                          <span
                            className="ml-auto h-1.5 w-1.5 rounded-full"
                            style={{
                              backgroundColor:
                                codesById.get(segCodings[0].code_ids[0])?.color ??
                                "var(--accent)",
                            }}
                            title="Coded passage"
                          />
                        )}
                      </header>

                      <PassageText
                        segmentId={seg.id}
                        text={seg.text}
                        coded={segCodings}
                        codedSegments={codedSegments}
                        activeCoder={activeCoder}
                        codeFilter={codeFilter}
                        setCodeFilter={setCodeFilter}
                        openNoteFor={openNoteForCoding}
                        removeCodeFromCoding={removeCodeFromCoding}
                        clearMemoForCoding={clearMemoForCoding}
                        codesById={codesById}
                        pending={
                          pendingSpan && pendingSpan.segmentId === seg.id
                            ? { start: pendingSpan.start, end: pendingSpan.end }
                            : null
                        }
                        showNotes={showNotes}
                        saveMemoForCoding={saveMemoForCoding}
                      />

                      {/* Coding Pills Footer */}
                      {segCodings.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pt-1">
                          {segCodings.map((coding) => {
                            const theirs = coding.coder_name !== activeCoder;
                            return (
                              <span
                                key={coding.id}
                                className="inline-flex items-center gap-1"
                              >
                                {coding.code_ids.map((id) => {
                                  const code = codesById.get(id);
                                  if (!code) return null;
                                  return (
                                    <button
                                      key={id}
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setCodeFilter(code.id);
                                      }}
                                      title={
                                        theirs
                                          ? `${coding.coder_name} coded this — show only passages coded "${code.name}"`
                                          : `Show only passages coded "${code.name}"`
                                      }
                                      className="rounded-full px-2 py-0.5 text-[11px] font-medium text-white transition-opacity hover:opacity-80"
                                      style={{ backgroundColor: code.color }}
                                    >
                                      {code.name}
                                    </button>
                                  );
                                })}
                                {theirs && (
                                  <span
                                    className="text-[11px]"
                                    style={{ color: "var(--ink-3)" }}
                                  >
                                    {coding.coder_name}
                                  </span>
                                )}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      <SelectionBubble
        anchor={bubbleAnchor}
        onDismiss={() => {
          setBubbleAnchor(null);
          setPendingSelection(null);
        }}
      />

      <NewInterviewModal
        open={showNewInterview}
        knownLabels={interviews.map((i) => i.participant_label)}
        onCancel={() => setShowNewInterview(false)}
        onConfirm={handleNewInterviewConfirm}
      />

      {editingInterview && (
        <InterviewSettingsModal
          interview={editingInterview}
          onClose={() => setEditingInterview(null)}
          onRename={renameInterview}
          onDelete={deleteInterview}
          loadImpact={interviewDeleteImpact}
        />
      )}

      {showLinkPanel && (
        <TranscriptLinkPanel
          open={showLinkPanel}
          onClose={() => setShowLinkPanel(false)}
        />
      )}
    </main>
  );
}

/**
 * PassageText with multi-code underlines (B2), mark context menu (A2), and NoteEditor integration (A7).
 */
function PassageText({
  segmentId,
  text,
  coded,
  codedSegments,
  activeCoder,
  codeFilter,
  setCodeFilter,
  openNoteFor,
  removeCodeFromCoding,
  clearMemoForCoding,
  codesById,
  pending,
  showNotes,
  saveMemoForCoding,
}: {
  segmentId: string;
  text: string;
  coded: CodedSegment[];
  codedSegments: CodedSegment[];
  activeCoder: string;
  codeFilter: string | null;
  setCodeFilter: (codeId: string | null) => void;
  openNoteFor: (codedSegmentId: string) => void;
  removeCodeFromCoding: (codingId: string, codeId: string) => Promise<void>;
  clearMemoForCoding: (codingId: string) => Promise<void>;
  codesById: Map<string, Code>;
  pending: { start: number; end: number } | null;
  showNotes: boolean;
  saveMemoForCoding: (
    codedSegmentId: string,
    memo: string,
    options?: { silent?: boolean },
  ) => Promise<CodedSegment>;
}) {
  const runs = useMemo(
    () => highlightRuns(text, coded, codesById),
    [text, coded, codesById],
  );
  const notes = useMemo(
    () => coded.filter((coding) => coding.memo?.trim()),
    [coded],
  );
  const noteKey = notes
    .map(
      (coding) =>
        `${coding.id}:${coding.memo}:${coding.char_start}:${coding.char_end}`,
    )
    .join("|");
  const textRootRef = useRef<HTMLDivElement>(null);
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [noteTops, setNoteTops] = useState<Record<string, number>>({});
  const [hoveredStripeCodeId, setHoveredStripeCodeId] = useState<string | null>(null);
  const [stripeLayout, setStripeLayout] = useState<StripeLayoutResult | null>(null);

  const pendingRun =
    pending && pending.end > pending.start
      ? { start: pending.start, end: pending.end }
      : null;
  const dark = usePrefersDark();

  useLayoutEffect(() => {
    const root = textRootRef.current;
    const paragraph = root?.querySelector<HTMLElement>("[data-passage-copy]");
    if (!root || !paragraph) return;

    const base = paragraph.getBoundingClientRect().top;
    const anchors = [
      ...paragraph.querySelectorAll<HTMLElement>("[data-run-start]"),
    ];

    if (showNotes && notes.length > 0) {
      const next: Record<string, number> = {};
      for (const coding of notes) {
        const start = coding.char_start ?? 0;
        const anchor =
          anchors.find(
            (element) =>
              Number(element.dataset.runStart) <= start &&
              Number(element.dataset.runEnd) > start,
          ) ?? anchors[0];
        if (anchor)
          next[coding.id] = Math.max(
            0,
            anchor.getBoundingClientRect().top - base,
          );
      }
      setNoteTops(next);
    } else if (Object.keys(noteTops).length > 0) {
      setNoteTops({});
    }

    const layout = computeStripeLayout({
      coded,
      codesById,
      activeCoder,
      codeFilter,
      passageHeight: paragraph.offsetHeight,
      measureSpans: (coding) => {
        const start = coding.char_start ?? 0;
        const end = coding.char_end ?? 0;
        const matchingAnchors = anchors.filter((el) => {
          const rs = Number(el.dataset.runStart);
          const re = Number(el.dataset.runEnd);
          return rs < end && re > start;
        });
        if (matchingAnchors.length === 0) return [];
        return matchingAnchors.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            top: Math.max(0, r.top - base),
            height: r.height,
          };
        });
      },
    });
    setStripeLayout(layout);
  }, [showNotes, text, coded, noteKey, codesById, activeCoder, codeFilter]);

  type Piece = HighlightRun & { pending: boolean };
  const pieces: Piece[] = runs.flatMap((run): Piece[] => {
    if (
      run.codes.length > 0 ||
      !pendingRun ||
      run.end <= pendingRun.start ||
      run.start >= pendingRun.end
    ) {
      return [{ ...run, pending: false }];
    }
    const s = Math.max(run.start, pendingRun.start);
    const e = Math.min(run.end, pendingRun.end);
    const out: Piece[] = [];
    if (run.start < s)
      out.push({ ...run, end: s, text: text.slice(run.start, s), pending: false });
    out.push({ ...run, start: s, end: e, text: text.slice(s, e), pending: true });
    if (e < run.end)
      out.push({ ...run, start: e, text: text.slice(e, run.end), pending: false });
    return out;
  });

  return (
    <div ref={textRootRef} className="relative">
      {/* Left stripe gutter */}
      {stripeLayout && (
        <div
          className="absolute left-0 top-0 bottom-0 w-5 select-none pointer-events-auto z-10"
          aria-hidden="true"
        >
          {stripeLayout.stripes.map((s, idx) => {
            const isHovered = hoveredStripeCodeId === s.codeId;
            return (
              <div
                key={`${s.codeId}-${idx}`}
                title={`${s.codeName}${s.isDashed ? " (other coder)" : ""}`}
                onPointerEnter={() => setHoveredStripeCodeId(s.codeId)}
                onPointerLeave={() => setHoveredStripeCodeId(null)}
                className="absolute cursor-pointer transition-opacity"
                style={{
                  left: s.columnIndex * 5,
                  top: s.top,
                  height: s.height,
                  width: 3,
                  borderLeft: s.isDashed
                    ? `3px dashed ${s.color}`
                    : `3px solid ${s.color}`,
                  opacity: hoveredStripeCodeId && !isHovered ? 0.35 : 1,
                  borderRadius: 1,
                }}
              />
            );
          })}
          {stripeLayout.overflowCount > 0 && (
            <div
              className="absolute top-0 right-0 text-[9px] font-sans font-medium px-0.5 rounded bg-surface-sunken text-muted cursor-help"
              title={stripeLayout.overflowCodes.map((c) => c.name).join(", ")}
            >
              +{stripeLayout.overflowCount}
            </div>
          )}
        </div>
      )}

      <p data-passage-copy className="pl-6 pr-7 font-serif text-[15.5px] leading-[1.62]">
        {pieces.map((run) => {
          const hasOtherCoder =
            Boolean(activeCoder && run.coders.some((c) => c !== activeCoder)) ||
            run.unresolvedCount > 0;

          if (run.codes.length === 0) {
            if (run.unresolvedCount > 0) {
              return (
                <span key={run.start} data-run-start={run.start} data-run-end={run.end}>
                  <mark
                    title={formatRunAttribution(run, activeCoder)}
                    className="rounded-[3px] px-px cursor-help"
                    style={{
                      color: "inherit",
                      background: dark ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.07)",
                      boxShadow: `inset 0 -1px 0 0 ${dark ? "rgba(255, 255, 255, 0.3)" : "rgba(0, 0, 0, 0.25)"}`,
                      textDecoration: "underline",
                      textDecorationColor: dark ? "rgba(255, 255, 255, 0.55)" : "rgba(0, 0, 0, 0.45)",
                      textUnderlineOffset: "2px",
                    }}
                  >
                    {run.text}
                  </mark>
                </span>
              );
            }
            return (
              <span key={run.start} data-run-start={run.start} data-run-end={run.end}>
                <span
                  style={
                    run.pending
                      ? {
                          background: "var(--accent-soft)",
                          boxShadow: "inset 0 -2px 0 0 var(--accent)",
                          borderRadius: 3,
                        }
                      : undefined
                  }
                >
                  {run.text}
                </span>
              </span>
            );
          }

          const hasHoveredStripe = hoveredStripeCodeId !== null;
          const isStripeHighlighted =
            hasHoveredStripe && run.codes.some((c) => c.id === hoveredStripeCodeId);
          const isFilterHighlighted =
            Boolean(codeFilter) && run.codes.some((c) => c.id === codeFilter);

          let bg = dark ? "rgba(255, 255, 255, 0.085)" : "rgba(0, 0, 0, 0.055)";
          if (isStripeHighlighted) {
            const matchedCode = run.codes.find((c) => c.id === hoveredStripeCodeId);
            if (matchedCode) {
              bg = `${matchedCode.color}${dark ? "40" : "2e"}`;
            }
          } else if (isFilterHighlighted) {
            const matchedCode = run.codes.find((c) => c.id === codeFilter);
            if (matchedCode) {
              bg = `${matchedCode.color}${dark ? "40" : "2e"}`;
            }
          } else if (hasHoveredStripe) {
            bg = dark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.02)";
          }

          return (
            <span key={run.start} data-run-start={run.start} data-run-end={run.end}>
              <mark
                title={formatRunAttribution(run, activeCoder)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const items = buildMarkMenuItems({
                    segmentId,
                    run: { start: run.start, end: run.end, wholeTurnOnly: run.wholeTurnOnly },
                    codedSegments,
                    codesById,
                    activeCoder,
                    codeFilter,
                    setCodeFilter,
                    openNoteFor,
                    removeCodeFromCoding,
                    clearMemoForCoding,
                  });
                  openContextMenu(e, items);
                }}
                className="rounded-[3px] px-px cursor-context-menu"
                style={{
                  color: "inherit",
                  background: bg,
                  textDecoration: hasOtherCoder ? "underline" : undefined,
                  textDecorationColor: dark ? "rgba(255, 255, 255, 0.55)" : "rgba(0, 0, 0, 0.45)",
                  textUnderlineOffset: "2px",
                }}
              >
                {run.text}
              </mark>
            </span>
          );
        })}
      </p>

      {showNotes &&
        notes.map((coding) => {
          const top = noteTops[coding.id] ?? 0;
          return (
            <div
              key={coding.id}
              className="absolute right-0 z-20"
              style={{ top }}
            >
              <button
                type="button"
                aria-label={`${expandedNoteId === coding.id ? "Collapse" : "Expand"} note`}
                aria-expanded={expandedNoteId === coding.id}
                onClick={(event) => {
                  event.stopPropagation();
                  setExpandedNoteId((current) =>
                    current === coding.id ? null : coding.id,
                  );
                }}
                className="grid h-5 w-5 place-items-center rounded-full transition-colors hover:bg-[var(--fill-hi)]"
                style={{ color: "var(--accent)" }}
                title="Show passage note"
              >
                <Icon name="note" size={13} />
              </button>
              {expandedNoteId === coding.id && (
                <PassageNoteCard
                  coding={coding}
                  passageText={text}
                  codesById={codesById}
                  onClose={() => setExpandedNoteId(null)}
                  saveMemoForCoding={saveMemoForCoding}
                />
              )}
            </div>
          );
        })}
    </div>
  );
}

function PassageNoteCard({
  coding,
  passageText,
  codesById,
  onClose,
  saveMemoForCoding,
}: {
  coding: CodedSegment;
  passageText: string;
  codesById: Map<string, Code>;
  onClose: () => void;
  saveMemoForCoding: (
    codedSegmentId: string,
    memo: string,
    options?: { silent?: boolean },
  ) => Promise<CodedSegment>;
}) {
  const quote =
    coding.char_start != null && coding.char_end != null
      ? passageText.slice(coding.char_start, coding.char_end)
      : passageText;
  const codeItems = coding.code_ids
    .map((id) => codesById.get(id))
    .filter((code): code is Code => !!code);

  const title = (
    <div className="flex flex-wrap gap-1">
      {codeItems.map((code) => (
        <span
          key={code.id}
          className="rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white"
          style={{ background: code.color }}
        >
          {code.name}
        </span>
      ))}
    </div>
  );

  const subtitle = quote ? (
    <span className="line-clamp-2 block font-serif italic text-[11px] pt-0.5">
      “{quote}”
    </span>
  ) : undefined;

  return (
    <div
      className="glass-card absolute right-6 top-0 w-72 p-3 shadow-xl z-30"
      onClick={(event) => event.stopPropagation()}
    >
      <NoteEditor
        initialMemo={coding.memo ?? ""}
        title={title}
        subtitle={subtitle}
        onSave={async (memo) => {
          await saveMemoForCoding(coding.id, memo);
        }}
        onClose={onClose}
        autoFocus
      />
    </div>
  );
}

function EmptyTranscript({
  importing,
  onImport,
  onScanFolder,
  hasInterview,
  awaitedPassages,
  pendingCoded,
}: {
  importing: boolean;
  onImport: () => void;
  onScanFolder?: () => void;
  hasInterview: boolean;
  awaitedPassages: number | null;
  pendingCoded: number;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
      <div
        className="grid h-14 w-14 place-items-center rounded-[18px]"
        style={{ background: "var(--fill)", color: "var(--ink-3)" }}
      >
        <Icon name="note" size={24} />
      </div>
      <p className="mt-4 text-[15px] font-medium">
        {awaitedPassages
          ? "Your coder has this transcript"
          : hasInterview
            ? "This participant has no transcript linked on this computer"
            : "No transcript yet"}
      </p>
      <p className="hint mt-1.5 max-w-xs">
        {awaitedPassages ? (
          <>
            They have <strong>{awaitedPassages}</strong> passages here. Import
            the same file from your shared folder and your coding will line up
            with theirs automatically.
          </>
        ) : (
          <>
            Zoom captions, SRT, a Word document, or plain text with speaker
            labels. Codemap splits it into speaker turns you can code one at a
            time.
          </>
        )}
      </p>
      {pendingCoded > 0 && (
        <p
          className="mt-3 rounded-[11px] px-3 py-2 text-[12.5px]"
          style={{ background: "var(--ok-soft)", color: "var(--ok)" }}
        >
          <strong>{pendingCoded}</strong> coded passage
          {pendingCoded === 1 ? "" : "s"} from your colleague{" "}
          {pendingCoded === 1 ? "is" : "are"} already on this computer. Importing
          the transcript attaches {pendingCoded === 1 ? "it" : "them"}
          automatically.
        </p>
      )}

      <div className="mt-5 flex items-center gap-2">
        <button
          type="button"
          onClick={onImport}
          disabled={importing}
          className="btn btn-primary"
        >
          <Icon name="import" size={15} />
          {importing ? "Importing…" : "Import transcript"}
        </button>
        {onScanFolder && (
          <button
            type="button"
            onClick={onScanFolder}
            disabled={importing}
            className="btn btn-secondary gap-1.5"
          >
            <Icon name="folder" size={14} />
            Scan folder…
          </button>
        )}
      </div>
    </div>
  );
}
