import { useEffect, useState } from "react";
import { Modal } from "./ui/Surfaces";
import { StudyLabelField } from "./StudyLabelField";
import { Icon } from "./ui/Icon";
import { useSyncStore } from "../store/sync-store";
import { nextParticipantId } from "../lib/study-label";

interface NewInterviewModalProps {
  open: boolean;
  defaultLabel?: string;
  /** Labels this study already holds, including ones known only via sync. */
  knownLabels?: string[];
  onCancel: () => void;
  onConfirm: (label: string) => void;
}

export function NewInterviewModal({
  open,
  defaultLabel = "",
  knownLabels = [],
  onCancel,
  onConfirm,
}: NewInterviewModalProps) {
  const [label, setLabel] = useState(defaultLabel);
  const [touched, setTouched] = useState(false);
  const [showCustom, setShowCustom] = useState(knownLabels.length === 0);
  const inGroup = useSyncStore((s) => s.status?.inGroup ?? false);

  useEffect(() => {
    if (open) {
      const suggested = defaultLabel || nextParticipantId(knownLabels);
      setLabel(suggested);
      setTouched(false);
      setShowCustom(knownLabels.length === 0 || !!defaultLabel || !suggested);
    }
  }, [open, defaultLabel, knownLabels]);

  const trimmed = label.trim();
  const canSubmit = trimmed.length > 0;

  function submit() {
    setTouched(true);
    if (canSubmit) onConfirm(trimmed);
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Add participant"
      subtitle={
        showCustom
          ? inGroup
            ? `This adds ${trimmed || "this participant"} to the study for everyone. Use the ID from your protocol.`
            : "Give this participant their ID from your protocol, then choose the transcript file."
          : "Pick a participant already in this study, or add a new one."
      }
      footer={
        showCustom ? (
          <>
            {knownLabels.length > 0 && (
              <button
                type="button"
                onClick={() => setShowCustom(false)}
                className="btn btn-ghost mr-auto"
              >
                Back to list
              </button>
            )}
            <button type="button" onClick={onCancel} className="btn btn-ghost">
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="btn btn-primary"
            >
              Choose transcript…
            </button>
          </>
        ) : (
          <button type="button" onClick={onCancel} className="btn btn-ghost">
            Cancel
          </button>
        )
      }
    >
      {!showCustom && knownLabels.length > 0 ? (
        <div className="flex flex-col gap-4">
          <div>
            <label className="label mb-2">Participants in this study</label>
            <div className="flex flex-col gap-1.5">
              {knownLabels.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => onConfirm(k)}
                  className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition-all hover:bg-[var(--fill)] hover:border-[var(--ink-4)]"
                >
                  <span className="font-medium text-[14px]">{k}</span>
                  <span className="text-[12px] text-[var(--ink-3)] flex items-center gap-1">
                    Choose transcript <Icon name="arrowRight" size={12} />
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-[var(--border)] pt-3">
            <button
              type="button"
              onClick={() => setShowCustom(true)}
              className="btn btn-outline w-full gap-1.5"
            >
              <Icon name="plus" size={13} />
              Add a new participant…
            </button>
          </div>
        </div>
      ) : (
        <>
          <StudyLabelField
            id="new-interview-label"
            value={label}
            onChange={setLabel}
            knownLabels={knownLabels}
            autoFocus
          />
          {touched && !canSubmit && (
            <p className="hint mt-2" style={{ color: "var(--danger)" }}>
              Enter a Participant ID to continue.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
