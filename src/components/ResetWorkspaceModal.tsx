import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../store/project-store";
import { Modal } from "./ui/Surfaces";
import { Icon } from "./ui/Icon";

export function ResetWorkspaceModal() {
  const {
    showResetConfirm,
    dismissResetConfirm,
    confirmResetWorkspace,
    activeInterviewId,
    interviews,
  } = useProjectStore(
    useShallow((s) => ({
      showResetConfirm: s.showResetConfirm,
      dismissResetConfirm: s.dismissResetConfirm,
      confirmResetWorkspace: s.confirmResetWorkspace,
      activeInterviewId: s.activeInterviewId,
      interviews: s.interviews,
    })),
  );

  const [scope, setScope] = useState<"all" | "active">("all");
  const [clearHubMemos, setClearHubMemos] = useState(true);
  const [clearActivityLog, setClearActivityLog] = useState(false);

  const activeInterview = interviews.find((i) => i.id === activeInterviewId);

  return (
    <Modal
      open={showResetConfirm}
      onClose={dismissResetConfirm}
      title="Reset coding"
      subtitle="Removes applied codes and block IDs. The codebook is always kept."
      width="max-w-lg"
      footer={
        <>
          <button
            type="button"
            onClick={() => dismissResetConfirm()}
            className="btn btn-ghost"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              confirmResetWorkspace({ scope, clearHubMemos, clearActivityLog })
            }
            className="btn btn-danger"
          >
            Reset coding
          </button>
        </>
      }
    >
      <div
        className="flex items-start gap-2.5 rounded-[13px] px-3.5 py-2.5 text-[12.5px]"
        style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
      >
        <Icon name="alert" size={15} />
        <span>
          Block IDs (q001…) renumber from scratch on re-coding. Any CSV a
          teammate already exported will no longer line up.
        </span>
      </div>

      <fieldset className="mt-5">
        <legend className="eyebrow mb-2">Scope</legend>
        <div className="flex flex-col gap-1.5">
          <Choice
            type="radio"
            name="reset-scope"
            checked={scope === "all"}
            onChange={() => setScope("all")}
            label="All interviews"
          />
          <Choice
            type="radio"
            name="reset-scope"
            checked={scope === "active"}
            onChange={() => setScope("active")}
            disabled={!activeInterviewId}
            label="This interview only"
            note={activeInterview?.participant_label}
          />
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className="eyebrow mb-2">Also clear</legend>
        <div className="flex flex-col gap-1.5">
          <Choice
            type="checkbox"
            checked={clearHubMemos}
            onChange={(v) => setClearHubMemos(v)}
            label="Interview memos"
          />
          <Choice
            type="checkbox"
            checked={clearActivityLog}
            onChange={(v) => setClearActivityLog(v)}
            label="Activity log"
            note="the reset itself is still logged"
          />
        </div>
      </fieldset>

      <p
        className="mt-5 rounded-[12px] px-3.5 py-2.5 text-[12px] leading-relaxed"
        style={{ background: "var(--fill)", color: "var(--ink-3)" }}
      >
        Always cleared: applied codes, segment memos, block IDs.
        <br />
        Always kept: the codebook — names, definitions, colours.
      </p>
    </Modal>
  );
}

function Choice({
  type,
  name,
  checked,
  onChange,
  label,
  note,
  disabled,
}: {
  type: "radio" | "checkbox";
  name?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  note?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className="flex items-center gap-2.5 text-[13px]"
      style={{ opacity: disabled ? 0.45 : 1 }}
    >
      <input
        type={type}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
      {note && (
        <span className="text-[12px]" style={{ color: "var(--ink-4)" }}>
          ({note})
        </span>
      )}
    </label>
  );
}
