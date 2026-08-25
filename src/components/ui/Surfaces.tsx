import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useFocusTrap } from "../../hooks/useFocusTrap";

/**
 * Render at the document root, escaping every ancestor.
 *
 * `position: fixed` is only relative to the viewport while no ancestor
 * establishes a containing block — and `backdrop-filter` does, exactly like
 * `transform` and `filter`. Six classes in this app carry `backdrop-filter`,
 * and `.glass-panel` wraps the codebook and memo rails, so a dialog opened
 * from either one was being laid out inside a ~250px column: the sheet was
 * squeezed, its footer overflowed, and because the footer justifies to the
 * end, the overflow spilled off the *left* edge where it could not be
 * clicked. The Delete button in the code editor was unreachable this way.
 *
 * Portalling is the structural fix — it cannot regress when some future panel
 * gains a blur. This is the second time `backdrop-filter` has caused a bug
 * here; the first was the toolbar's stacking context in 0.3.0.
 */
function Portal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Sits directly under the title. Keep it to one line. */
  subtitle?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /**
   * Actions pinned to the footer's left edge — typically a destructive one.
   * A separate slot rather than `mr-auto` inside `footer`: with the footer
   * justified to the end, an auto margin only works while everything fits,
   * and the moment it doesn't the leading button is the one pushed off-screen.
   */
  footerLeading?: ReactNode;
  /** Tailwind max-width class. Defaults to a comfortable dialog width. */
  width?: string;
  /** Hide the × so the dialog can only be dismissed by its own buttons. */
  hideClose?: boolean;
}

/** Centred glass dialog. Esc and scrim-click both dismiss unless hideClose. */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  footerLeading,
  width = "max-w-md",
  hideClose = false,
}: ModalProps) {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  useEscape(open, onClose);
  useFocusTrap(open, sheetRef);
  if (!open) return null;

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
        <button
          type="button"
          className="scrim"
          aria-label={`Close ${title}`}
          onClick={onClose}
        />
        <div
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={`glass-sheet anim-sheet relative flex max-h-[86vh] w-full flex-col ${width}`}
        >
          <div className="flex items-start justify-between gap-4 px-7 pt-6">
            <div className="min-w-0">
              <h2
                id={titleId}
                className="text-[17px] font-semibold tracking-[-0.01em]"
              >
                {title}
              </h2>
              {subtitle && <p className="hint mt-1">{subtitle}</p>}
            </div>
            {!hideClose && (
              <button
                type="button"
                onClick={onClose}
                className="btn btn-ghost btn-icon -mr-1.5 -mt-0.5"
                aria-label="Close"
              >
                <Icon name="close" size={15} />
              </button>
            )}
          </div>

          {children && <div className="scroll px-7 py-5">{children}</div>}

          {(footer || footerLeading) && (
            // `flex-wrap` so a cramped dialog stacks the rows instead of
            // pushing a control out of the sheet.
            <div className="flex flex-wrap items-center justify-between gap-2 px-7 pb-6 pt-1">
              <div className="flex items-center gap-2">{footerLeading}</div>
              <div className="ml-auto flex items-center gap-2">{footer}</div>
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}

interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  /** Rendered in the header row, left of the close button. */
  actions?: ReactNode;
  children: ReactNode;
  width?: string;
}

/** Right-edge sheet for reference content: guide, files, activity. */
export function SideSheet({
  open,
  onClose,
  title,
  subtitle,
  actions,
  children,
  width = "max-w-xl",
}: SideSheetProps) {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  useEscape(open, onClose);
  useFocusTrap(open, sheetRef);
  if (!open) return null;

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex justify-end">
        <button
          type="button"
          className="scrim"
          aria-label={`Close ${title}`}
          onClick={onClose}
        />
        <div
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={`glass-sheet anim-slide relative flex h-full w-full flex-col rounded-r-none ${width}`}
        >
          <header className="flex items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-[15px] font-semibold">
                {title}
              </h2>
              {subtitle && <p className="hint mt-0.5">{subtitle}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {actions}
              <button
                type="button"
                onClick={onClose}
                className="btn btn-ghost btn-icon"
                aria-label="Close"
              >
                <Icon name="close" size={15} />
              </button>
            </div>
          </header>
          <div className="divider mx-5" />
          {children}
        </div>
      </div>
    </Portal>
  );
}
