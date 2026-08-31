import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../store/project-store";
import { SideSheet } from "./ui/Surfaces";
import { useAutosaveMemo } from "./MemoPanel";

/**
 * The interview-wide analytic memo.
 *
 * Lived at the bottom of the right rail until 0.16.0, directly beneath a note
 * about one passage. Two different altitudes of thought in one column, and the
 * cheaper one to reach won: cross-cutting reflection got written into a note
 * attached to whichever passage happened to be selected. It is a sheet now, so
 * opening it is a deliberate change of gear.
 */
export function InterviewMemoPanel() {
  const {
    hubMemo,
    setHubMemo,
    hubMemoDirty,
    saveHubMemo,
    showInterviewMemo,
    setShowInterviewMemo,
    interviews,
    activeInterviewId,
  } = useProjectStore(
    useShallow((s) => ({
      hubMemo: s.hubMemo,
      setHubMemo: s.setHubMemo,
      hubMemoDirty: s.hubMemoDirty,
      saveHubMemo: s.saveHubMemo,
      showInterviewMemo: s.showInterviewMemo,
      setShowInterviewMemo: s.setShowInterviewMemo,
      interviews: s.interviews,
      activeInterviewId: s.activeInterviewId,
    })),
  );

  const interview = interviews.find((i) => i.id === activeInterviewId);
  const state = useAutosaveMemo(hubMemo, hubMemoDirty, saveHubMemo, showInterviewMemo);

  return (
    <SideSheet
      open={showInterviewMemo}
      onClose={() => setShowInterviewMemo(false)}
      title="Notes on this interview"
      subtitle={
        interview
          ? `${interview.participant_label} — yours alone, never synced`
          : undefined
      }
      width="max-w-lg"
      actions={
        state === "idle" ? null : (
          <span className="hint text-[11px]" role="status">
            {state === "saving" ? "Saving…" : "Saved"}
          </span>
        )
      }
    >
      <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
        <p className="hint text-[11.5px]">
          About the interview as a whole, not any one passage. Memo fields are excluded from collaboration sync. Exports may include them.
        </p>
        <textarea
          value={hubMemo}
          onChange={(e) => setHubMemo(e.target.value)}
          placeholder="Cross-cutting reflections on this interview…"
          aria-label="Interview analytic memo"
          className="field mt-2 min-h-0 flex-1 text-[13px]"
        />
      </div>
    </SideSheet>
  );
}
