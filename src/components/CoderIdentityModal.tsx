import { useShallow } from "zustand/react/shallow";
import { Modal } from "./ui/Surfaces";
import { useProjectStore } from "../store/project-store";
import { useSyncStore } from "../store/sync-store";

/**
 * Who is at the keyboard.
 *
 * Coding is refused until this is answered, and there is deliberately no
 * default: in reflexive TA, who saw what *is* the analysis, so a passage
 * stamped with a guess is worse than one that could not be coded yet. The
 * answer is remembered per project path, so this appears once per machine per
 * project rather than every launch.
 *
 * Replaces the identity half of the old opening brief. The rest of that brief —
 * what changed since the last handoff, and whether a teammate still held the
 * copy — described a workflow that no longer exists: coding now flows
 * continuously through sync, so there is no "since last handoff" to report and
 * no copy to hold.
 */
export function CoderIdentityModal() {
  const { show, project, confirmCoder, dismiss } = useProjectStore(
    useShallow((s) => ({
      show: s.showIdentityPrompt,
      project: s.project,
      confirmCoder: s.confirmCoder,
      dismiss: s.dismissIdentityPrompt,
    })),
  );

  const inGroup = useSyncStore((s) => s.status?.inGroup ?? false);

  if (!project || inGroup) return null;
  const coders = project.coders.filter((c) => c.trim());

  return (
    <Modal
      open={show}
      onClose={dismiss}
      title="Who's coding?"
      subtitle="Everything you code is filed under this name."
      width="max-w-sm"
    >
      <div className="flex flex-col gap-1">
        {coders.map((coder) => (
          <button
            key={coder}
            type="button"
            className="btn btn-ghost btn-block justify-between"
            onClick={() => void confirmCoder(coder)}
          >
            <span>{coder}</span>
            <span aria-hidden="true">→</span>
          </button>
        ))}
        {coders.length === 0 && (
          <p className="hint">
            This project lists no coders. Add one in the project settings before
            coding.
          </p>
        )}
      </div>
    </Modal>
  );
}
