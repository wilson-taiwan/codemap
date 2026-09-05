import { useState, type ReactNode } from "react";
import { Tooltip } from "./Tooltip";

export interface InfoTipProps {
  content: ReactNode;
  ariaLabel?: string;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
}

export function InfoTip({
  content,
  ariaLabel = "More information",
  className = "",
  side = "top",
}: InfoTipProps) {
  const [closedByEsc, setClosedByEsc] = useState(false);

  return (
    <Tooltip
      content={content}
      side={side}
      disabled={closedByEsc}
      className={`inline-flex items-center align-middle ${className}`}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setClosedByEsc(true);
          }
        }}
        onBlur={() => {
          setClosedByEsc(false);
        }}
        onMouseEnter={() => {
          setClosedByEsc(false);
        }}
        className="grid h-3 w-3 place-items-center rounded-full border border-[var(--ink-4)] text-[9px] font-sans font-medium text-[var(--ink-3)] leading-none transition-colors hover:border-[var(--ink-2)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
      >
        ?
      </button>
    </Tooltip>
  );
}
