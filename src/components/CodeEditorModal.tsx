import { useEffect, useState } from "react";
import { Modal } from "./ui/Surfaces";
import { CODE_PALETTE } from "../lib/code-colors";
import { Icon } from "./ui/Icon";
import type { Code, DeleteCodeMode } from "../lib/types";

interface CodeEditorModalProps {
  code: Code | null;
  allCodes?: Code[];
  onClose: () => void;
  onSave: (input: {
    id: string;
    name: string;
    definition: string | null;
    inclusion_criteria?: string | null;
    exclusion_criteria?: string | null;
    example?: string | null;
    parent_id?: string | null;
    color: string;
  }) => Promise<void>;
  onDelete: (codeId: string, mode: DeleteCodeMode) => Promise<void>;
}

export function CodeEditorModal({
  code,
  allCodes = [],
  onClose,
  onSave,
  onDelete,
}: CodeEditorModalProps) {
  const [name, setName] = useState("");
  const [definition, setDefinition] = useState("");
  const [parentId, setParentId] = useState<string | null>(null);
  const [color, setColor] = useState<string>(CODE_PALETTE[0]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!code) return;
    setName(code.name);
    setDefinition(code.definition ?? "");
    setParentId(code.parent_id ?? null);
    setColor(code.color);
    setConfirmingDelete(false);
    setBusy(false);
  }, [code]);

  if (!code) return null;

  const trimmed = name.trim();
  const inUse = code.usage_count > 0;
  const hasChildren = allCodes.some((c) => c.parent_id === code.id);
  const dirty =
    trimmed !== code.name ||
    definition.trim() !== (code.definition ?? "") ||
    (parentId || null) !== (code.parent_id ?? null) ||
    color !== code.color;

  async function save() {
    if (!code || !trimmed || busy) return;
    setBusy(true);
    await onSave({
      id: code.id,
      name: trimmed,
      definition: definition.trim() || null,
      inclusion_criteria: code.inclusion_criteria ?? null,
      exclusion_criteria: code.exclusion_criteria ?? null,
      example: code.example ?? null,
      parent_id: parentId || null,
      color,
    });
    onClose();
  }

  async function remove(mode: DeleteCodeMode) {
    if (!code || busy) return;
    setBusy(true);
    await onDelete(code.id, mode);
    onClose();
  }

  if (confirmingDelete) {
    return (
      <Modal
        open
        onClose={onClose}
        title={`Delete "${code.name}"?`}
        subtitle={
          inUse
            ? `This code is on ${code.usage_count} ${code.usage_count === 1 ? "passage" : "passages"}.`
            : "Nothing has been coded with it yet."
        }
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
              onClick={() => remove("purge")}
              className="btn btn-danger"
              disabled={busy}
            >
              {inUse ? "Delete everywhere" : "Delete code"}
            </button>
          </>
        }
      >
        {inUse ? (
          <>
            <p className="text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
              Deleting removes it from those passages. Any passage where this
              was the only code stops being coded at all. That cannot be undone
              from inside the app.
            </p>
            <div className="divider my-3.5" />
            <p className="label">Or keep the analysis</p>
            <p
              className="mt-1 text-[13px] leading-relaxed"
              style={{ color: "var(--ink-2)" }}
            >
              Retiring hides it from the codebook but leaves the {code.usage_count}{" "}
              {code.usage_count === 1 ? "passage" : "passages"} tagged, and exports
              still carry the name. Retired codes can be brought back.
            </p>
            <button
              type="button"
              onClick={() => remove("retire")}
              className="btn btn-outline btn-block mt-2.5"
              disabled={busy}
            >
              <Icon name="eye" size={14} />
              Retire instead
            </button>
          </>
        ) : (
          <p className="text-[13px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
            No passage carries this code, so nothing else changes.
          </p>
        )}
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit code"
      subtitle={
        inUse
          ? `On ${code.usage_count} ${code.usage_count === 1 ? "passage" : "passages"} — renaming updates them all.`
          : "Not yet used on any passage."
      }
      footerLeading={
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
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
            disabled={!trimmed || !dirty || busy}
            className="btn btn-primary"
          >
            Save
          </button>
        </>
      }
    >
      <label className="label" htmlFor="code-name">
        Name
      </label>
      <input
        id="code-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
        className="field"
        autoFocus
      />

      <label className="label mt-3.5" htmlFor="code-definition">
        Definition
      </label>
      <textarea
        id="code-definition"
        value={definition}
        onChange={(e) => setDefinition(e.target.value)}
        rows={3}
        placeholder="What counts as this code, and what doesn't?"
        className="field text-[13px]"
      />
      <p className="hint mt-1.5">
        Shown under the code in the codebook and on hover.
      </p>

      <label className="label mt-3.5" htmlFor="code-parent">
        Parent code
      </label>
      {hasChildren ? (
        <p className="hint text-[12px]">
          This code has sub-codes under it. It cannot be placed under another code.
        </p>
      ) : (
        <>
          <select
            id="code-parent"
            value={parentId ?? ""}
            onChange={(e) => setParentId(e.target.value || null)}
            className="field"
          >
            <option value="">Top-level code (no parent)</option>
            {allCodes
              .filter((c) => c.id !== code.id && !c.parent_id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <p className="hint mt-1.5 text-[11.5px]">
            Organise sub-codes into two levels in the codebook.
          </p>
        </>
      )}

      <p className="label mt-3.5">Colour</p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {CODE_PALETTE.map((swatch) => (
          <button
            key={swatch}
            type="button"
            onClick={() => setColor(swatch)}
            aria-label={`Colour ${swatch}`}
            aria-pressed={color === swatch}
            className="grid h-7 w-7 place-items-center rounded-full transition-transform"
            style={{
              backgroundColor: swatch,
              transform: color === swatch ? "scale(1.12)" : "scale(1)",
              boxShadow: color === swatch ? `0 0 0 3px ${swatch}44` : "none",
            }}
          >
            {color === swatch && <Icon name="check" size={12} className="text-white" />}
          </button>
        ))}
      </div>
    </Modal>
  );
}
