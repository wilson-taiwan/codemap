import { useEffect, useState } from "react";
import { Modal } from "./ui/Surfaces";
import { Icon } from "./ui/Icon";
import { InfoTip } from "./ui/InfoTip";
import type { Interview, InterviewDeleteImpact } from "../lib/types";

interface InterviewSettingsModalProps {
  interview: Interview | null;
  onClose: () => void;
  onRename: (id: string, label: string, date: string | null) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  loadImpact: (id: string) => Promise<InterviewDeleteImpact>;
  /** Per-interview speaker redaction (T06). Local-only view/export layer. */
  redactionOn?: boolean;
  redactionPreview?: { real: string; alias: string }[];
  onToggleRedaction?: (on: boolean) => Promise<void>;
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
  redactionOn = false,
  redactionPreview = [],
  onToggleRedaction,
}: InterviewSettingsModalProps) {
  const [date, setDate] = useState("");
  const [impact, setImpact] = useState<InterviewDeleteImpact | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [redactionBusy, setRedactionBusy] = useState(false);
  const [redactionError, setRedactionError] = useState<string | null>(null);

  useEffect(() => {
    if (!interview) return;
    setDate(interview.interview_date ?? "");
    setConfirmingDelete(false);
    setImpact(null);
    setBusy(false);
    setRedactionBusy(false);
    setRedactionError(null);
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
            Save date
          </button>
        </>
      }
    >
      <label className="label">Participant ID</label>
      <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13.5px] font-medium text-[var(--ink-1)]">
        {interview.participant_label}
      </div>
      <p className="hint mt-1.5 flex items-center gap-1.5 text-[11.5px]">
        <span>Used to match this interview across group members.</span>
        <InfoTip content="Participant IDs cannot be changed after creation." />
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

      {onToggleRedaction && (
        <div className="mt-4 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-3">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span>
              <span className="block text-[13px] font-medium text-[var(--ink-1)]">
                Redact speaker names
              </span>
              <span className="hint mt-0.5 flex items-center gap-1.5 text-[11.5px]">
                <span>Shows Speaker 1, Speaker 2 on screen, copy, and export.</span>
                <InfoTip content="Stored speaker names are unchanged. This setting applies on this computer." />
              </span>
              <span className="hint mt-1 block text-[11px] text-[var(--ink-4)]">
                Applies immediately on this computer.
              </span>
            </span>
            <input
              type="checkbox"
              checked={redactionOn}
              disabled={redactionBusy}
              onChange={(e) => {
                const nextVal = e.target.checked;
                if (!onToggleRedaction || redactionBusy) return;
                setRedactionBusy(true);
                setRedactionError(null);
                void onToggleRedaction(nextVal)
                  .catch(() => {
                    setRedactionError("Could not save the redaction setting.");
                  })
                  .finally(() => {
                    setRedactionBusy(false);
                  });
              }}
              aria-label="Redact speaker names"
              className="h-4 w-4 shrink-0 accent-[var(--accent)]"
            />
          </label>
          {redactionError && (
            <p role="alert" className="mt-1.5 text-[11.5px] text-[var(--danger)] font-medium">
              {redactionError}
            </p>
          )}
          {redactionPreview.length > 0 && (
            <p className="hint mt-2 text-[11.5px]">
              {redactionPreview.map((p) => `${p.real} → ${p.alias}`).join(" · ")}
            </p>
          )}
        </div>
      )}
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
