import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { useGuideStore } from "../store/guide-store";
import { useSyncStore } from "../store/sync-store";
import { Icon, type IconName } from "./ui/Icon";
import { InfoTip } from "./ui/InfoTip";

interface Task {
  id: string;
  title: string;
  why: string;
  infoTip: string;
  icon: IconName;
  action?: { label: string; run: () => void };
  guideSection: string;
}

/**
 * The floating coach. Answers exactly one question — "what do I do next?" —
 * and disappears the moment it can no longer answer it.
 *
 * Setup is a chain: codes exist, a transcript exists, a passage has been coded,
 * and — if there is a second coder — sync is connected. Each link is a hard
 * prerequisite for the next, so showing them all at once is noise. One card,
 * one step.
 *
 * Sync comes last on purpose. It is the only step that is not required to do
 * any work at all. The × dismisses it for a solo study.
 */
export function NextStepCoach() {
  const { codes, segments, interviews, totalCodedCount } = useProjectStore(
    useShallow((s) => ({
      codes: s.codes,
      segments: s.segments,
      interviews: s.interviews,
      totalCodedCount: s.totalCodedCount,
    })),
  );
  const dismissed = useAppStore((s) => s.preferences.coach_dismissed);
  const setCoachDismissed = useAppStore((s) => s.setCoachDismissed);
  const setIntent = useAppStore((s) => s.setIntent);
  const openGuide = useGuideStore((s) => s.openGuide);
  const openSyncSheet = useSyncStore((s) => s.openSyncSheet);
  const syncStatus = useSyncStore((s) => s.status);

  const hasTranscript = interviews.length > 0 && segments.length > 0;
  const inGroup = !!syncStatus?.inGroup;

  const tasks: Task[] = [
    {
      id: "codes",
      title: "Add your first code",
      why: "Create a code, then start reading.",
      infoTip: "Codes live in the left panel and can grow as you read.",
      icon: "book",
      action: { label: "Add a code", run: () => setIntent("add-code") },
      guideSection: "add-code",
    },
    {
      id: "transcript",
      title: "Import a transcript",
      why: "Import VTT, SRT, Word, or plain text.",
      infoTip: "Fleuron splits supported files into speaker turns.",
      icon: "import",
      action: { label: "Import a transcript", run: () => setIntent("import-vtt") },
      guideSection: "import-vtt-first",
    },
    {
      id: "first-code",
      title: "Code your first passage",
      why: "Select words to code a span, or press C for the whole turn.",
      infoTip: "Right-click a turn to see the same whole-turn action.",
      icon: "sparkle",
      guideSection: "apply-codes",
    },
    {
      id: "sync",
      title: "Start a group with your coder",
      why: "Share coding with your group; transcript text stays local.",
      infoTip: "Coding metadata syncs. Transcript text stays on this computer.",
      icon: "people",
      action: { label: "Start a group", run: () => openSyncSheet() },
      guideSection: "sync-with-your-coder",
    },
  ];

  const steps = [
    codes.length > 0,
    hasTranscript,
    totalCodedCount > 0,
    inGroup,
  ];
  const doneCount = steps.filter(Boolean).length;

  const active =
    codes.length === 0
      ? tasks[0]
      : !hasTranscript
        ? tasks[1]
          : totalCodedCount === 0
            ? tasks[2]
            : inGroup
              ? null
              : tasks[3];

  if (!active || dismissed) return null;

  return (
    // Spans the transcript column only. `inset-x-0` put this across the whole
    // grid, so at 1024 the card ran under the memo rail and covered "Already
    // on this passage" — the panel telling you what your colleague coded.
    // --rail-l / --rail-r are published by WorkspaceLayout's grid.
    <div
      className="pointer-events-none absolute z-30 flex justify-center px-4 transition-all duration-160"
      style={{
        left: "var(--rail-l, 0px)",
        right: "var(--rail-r, 0px)",
        bottom: "calc(1rem + var(--toast-lift, 0px))",
      }}
    >
      <div
        className="glass-card anim-rise pointer-events-auto flex w-full max-w-xl items-start gap-3.5 p-4"
        role="status"
      >
        <span
          className="mt-px grid h-9 w-9 shrink-0 place-items-center rounded-full"
          style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
        >
          <Icon name={active.icon} size={17} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="eyebrow">Next step</span>
            <span className="flex gap-1" aria-label={`Step ${doneCount + 1} of 3`}>
              {tasks.map((t, i) => (
                <span
                  key={t.id}
                  className="h-1 w-4 rounded-full transition-colors"
                  style={{
                    background:
                      i < doneCount
                        ? "var(--ok)"
                        : i === doneCount
                          ? "var(--accent)"
                          : "var(--fill-hi)",
                  }}
                />
              ))}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <p className="text-[14px] font-medium">{active.title}</p>
            <InfoTip content={active.infoTip} />
          </div>
          <p className="hint mt-0.5">{active.why}</p>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {active.action && (
              <button
                type="button"
                onClick={active.action.run}
                className="btn btn-primary btn-sm"
              >
                {active.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => openGuide(active.guideSection)}
              className="btn btn-ghost btn-sm"
            >
              Show me how
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setCoachDismissed(true)}
          className="btn btn-ghost btn-icon shrink-0"
          aria-label="Hide setup guidance"
          title="Hide — bring it back from Settings"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}
