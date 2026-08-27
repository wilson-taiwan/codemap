import { useEffect, useState } from "react";
import { useConfirmStore } from "../store/confirm-store";
import { Modal } from "./ui/Surfaces";

/**
 * The single confirmation surface, mounted once in App. Renders whatever the
 * confirm store holds; behavior (dedupe, promise resolution) lives in the
 * store so callers never touch React lifecycle. Focus trapping, escape, and
 * scrim dismissal come from the shared Modal primitives.
 */
export function ConfirmDialog() {
  const open = useConfirmStore((s) => s.open);
  const options = useConfirmStore((s) => s.options);
  const answer = useConfirmStore((s) => s.answer);

  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open, options]);

  if (!open || !options) return null;

  const typedConfirmationMet =
    !options.typedConfirmation || typed === options.typedConfirmation;

  return (
    <Modal open={open} onClose={() => answer(false)} title={options.title}>
      {options.body && (
        <p className="text-[13.5px] leading-relaxed" style={{ color: "var(--ink-2)" }}>
          {options.body}
        </p>
      )}
      {options.typedConfirmation && (
        <div className="mt-4">
          <label className="label" htmlFor="confirm-typed">
            Type{" "}
            <span className="font-mono">{options.typedConfirmation}</span> to
            continue
          </label>
          <input
            id="confirm-typed"
            className="field mt-1"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="confirm-typed-input"
          />
        </div>
      )}
      <div className="mt-5 flex items-center justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={() => answer(false)}>
          {options.cancelLabel ?? "Cancel"}
        </button>
        <button
          type="button"
          className={`btn ${options.destructive ? "btn-danger" : "btn-primary"}`}
          disabled={!typedConfirmationMet}
          onClick={() => answer(true)}
          data-testid="confirm-accept"
        >
          {options.confirmLabel ?? "Continue"}
        </button>
      </div>
    </Modal>
  );
}
