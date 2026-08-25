import { useEffect, useRef, useState, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../store/project-store";
import type { Toast } from "../lib/types";
import { Icon } from "./ui/Icon";

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const [isPaused, setIsPaused] = useState(false);
  const [exiting, setExiting] = useState(false);
  const remainingRef = useRef(toast.type === "error" ? Infinity : 6000);
  const startRef = useRef(Date.now());

  useEffect(() => {
    if (toast.type === "error") return;

    if (isPaused) {
      const elapsed = Date.now() - startRef.current;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
      return;
    }

    startRef.current = Date.now();
    const timeout = setTimeout(() => {
      setExiting(true);
      setTimeout(() => onDismiss(toast.id), 160);
    }, remainingRef.current);

    return () => clearTimeout(timeout);
  }, [isPaused, toast.id, toast.type, onDismiss]);

  const handleClose = () => {
    setExiting(true);
    setTimeout(() => onDismiss(toast.id), 160);
  };

  const iconName =
    toast.type === "success"
      ? "checkCircle"
      : toast.type === "error"
        ? "alert"
        : "help";

  const iconColor =
    toast.type === "success"
      ? "var(--ok, #2e8b57)"
      : toast.type === "error"
        ? "var(--danger, #b03a34)"
        : "var(--accent)";

  return (
    <div
      role={toast.type === "error" ? "alert" : "status"}
      aria-live={toast.type === "error" ? "assertive" : "polite"}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
      className={`glass-card pointer-events-auto flex items-start gap-2.5 rounded-xl p-3 shadow-lg transition-all duration-160 ${
        exiting
          ? "translate-x-4 opacity-0"
          : "anim-slide-in-right opacity-100"
      }`}
      style={{
        maxWidth: 340,
        width: "100%",
        borderLeft: `3px solid ${iconColor}`,
      }}
    >
      <span className="mt-0.5 shrink-0" style={{ color: iconColor }}>
        <Icon name={iconName} size={15} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[12.5px] leading-snug" style={{ color: "var(--ink)" }}>
          {toast.text}
        </p>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              handleClose();
            }}
            className="mt-1.5 inline-flex items-center text-[11.5px] font-medium underline underline-offset-2 transition-opacity hover:opacity-80"
            style={{ color: "var(--accent)" }}
          >
            {toast.action.label}
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={handleClose}
        aria-label="Dismiss notice"
        className="grid h-5 w-5 shrink-0 place-items-center rounded-md text-[var(--ink-4)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)]"
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}

export function ToastStack() {
  const { toasts, dismissToast } = useProjectStore(
    useShallow((s) => ({
      toasts: s.toasts,
      dismissToast: s.dismissToast,
    })),
  );

  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!containerRef.current || toasts.length === 0) {
      document.documentElement.style.setProperty("--toast-lift", "0px");
      return;
    }
    const height = containerRef.current.offsetHeight;
    document.documentElement.style.setProperty("--toast-lift", `${height}px`);
    return () => {
      document.documentElement.style.setProperty("--toast-lift", "0px");
    };
  }, [toasts]);

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      ref={containerRef}
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-[80] flex max-w-[340px] flex-col-reverse gap-2"
    >
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          onDismiss={dismissToast}
        />
      ))}
    </div>,
    document.body,
  );
}
