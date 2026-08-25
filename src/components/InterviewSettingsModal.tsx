import { useEffect, useState } from "react";
import { Modal } from "./ui/Surfaces";
import { Icon } from "./ui/Icon";
import type { Interview, InterviewDeleteImpact } from "../lib/types";

interface InterviewSettingsModalProps {
  interview: Interview | null;
  onClose: () => void;
  onRename: (id: string, label: string, date: string | null) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  loadImpact: (id: string) => Promise<InterviewDeleteImpact>;
}

/**
 * Rename an interview or remove it.
 *
 * `create_interview` was the only interview command, so a participant label
 * typed wrong stayed wrong — in every export, permanently — and a throwaway
 * test interview could never be cleared out of the picker.
 *
 * Delete loads its real impact before offering the button. A transcript and a
 * set of coded passages disappearing is worth stating in numbers rather than
 * as a generic "are you sure".
 */
export function InterviewSettingsModal({
  interview,
  onClose,
  onRename,
  onDelete,
  loadImpact,
}: InterviewSettingsModalProps) {
  const [date, setDate] = useState("");
  const [impact, setImpact] = useState<InterviewDeleteImpact | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!interview) return;
    setDate(interview.interview_date ?? "");
    setConfirmingDelete(false);
    setImpact(null);
    setBusy(false);
  }, [interview]);

  if (!interview) return null;

  const dirty = (date || null) !== (interview.interview_date ?? null);

  async function save() {
    if (!interview || busy) return;
    setBusy(true);
    await onRename(interview.id, interview.participant_label, date || null);
    onClose();
  }

  async function openDeleteConfirm() {
    if (!interview) return;
    setConfirmingDelete(true);
    try {
      setImpact(await loadImpact(interview.id));
    } catch {
      setImpact(null);
    }
  }

  async function remove() {
    if (!interview || busy) return;
    setBusy(true);
    await onDelete(interview.id);
    onClose();
  }

  if (confirmingDelete) {
    const codedCount = impact?.coded_segment_count ?? 0;
    return (
      <Modal
        open
        onClose={onClose}
        title={`Delete "${interview.participant_label}"?`}
        subtitle="The transcript and every code on it go with it."
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="btn btn-ghost"
              disabled={busy}
            >
              Back
            </button>
            <button
              type="button"
              onClick={remove}
              className="btn btn-danger"
              disabled={busy}
            >
              Delete interview
            </button>
          </>
        }
      >
        {impact ? (
          <ul className="flex flex-col gap-1.5 text-[13px]">
            <ImpactRow
              label="Transcript segments"
              value={impact.segment_count}
              heavy={impact.segment_count > 0}
            />
            <ImpactRow
              label="Coded passages"
              value={codedCount}
              heavy={codedCount > 0}
            />
            {impact.has_hub_memo && (
              <li className="flex items-center gap-1.5" style={{ color: "var(--danger)" }}>
                <Icon name="alert" size={13} />
                The interview memo will be lost too.
              </li>
            )}
          </ul>
        ) : (
          <p className="hint">Checking what this would remove…</p>
        )}
        <p className="hint mt-3">
          {codedCount > 0
            ? "This cannot be undone from inside the app. The transcript file it was imported from is unaffected."
            : "This cannot be undone from inside the app."}
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Interview settings"
      subtitle={`${interview.segment_count} segment${interview.segment_count === 1 ? "" : "s"} imported.`}
      footerLeading={
        <button
          type="button"
          onClick={openDeleteConfirm}
          className="btn btn-ghost"
          style={{ color: "var(--danger)" }}
          disabled={busy}
        >
          <Icon name="trash" size={14} />
          Delete…
        </button>
      }
      footer={
        <>
          <button type="button" onClick={onClose} className="btn btn-ghost" disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || busy}
            className="btn btn-primary"
          >
            Save
          </button>
        </>
      }
    >
      <label className="label">Participant ID</label>
      <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13.5px] font-medium text-[var(--ink-1)]">
        {interview.participant_label}
      </div>
      <p className="hint mt-1.5 text-[11.5px]">
        A Participant ID cannot be changed — it is how your copy and your colleagues&apos; copies recognise the same interview.
      </p>

      <label className="label mt-3.5" htmlFor="interview-date">
        Interview date
      </label>
      <input
        id="interview-date"
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        className="field"
      />
    </Modal>
  );
}

function ImpactRow({
  label,
  value,
  heavy,
}: {
  label: string;
  value: number;
  heavy: boolean;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <span style={{ color: "var(--ink-2)" }}>{label}</span>
      <span
        className="font-mono tabular-nums"
        style={{
          color: heavy ? "var(--danger)" : "var(--ink-3)",
          fontWeight: heavy ? 600 : 400,
        }}
      >
        {value}
      </span>
    </li>
  );
}
