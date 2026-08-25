import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Code } from "../lib/types";

export interface NoteHoverCardTarget {
  element: HTMLElement;
  code: Code;
  quote: string;
  memo: string;
  coder: string;
  activeCoder: string;
}

export function NoteHoverCard({
  target,
  onDismiss,
}: {
  target: NoteHoverCardTarget | null;
  onDismiss: () => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!target) {
      setPos(null);
      return;
    }

    const rect = target.element.getBoundingClientRect();
    // Get the right edge of the codebook panel/aside
    const aside = target.element.closest("aside");
    const asideRect = aside ? aside.getBoundingClientRect() : rect;
    const left = asideRect.right + 8;

    const cardHeight = cardRef.current?.offsetHeight ?? 160;
    const viewportHeight = window.innerHeight;
    let top = rect.top + rect.height / 2 - cardHeight / 2;
    top = Math.max(8, Math.min(viewportHeight - cardHeight - 8, top));

    setPos({ top, left });
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const handleScroll = () => onDismiss();
    const handleMouseDown = () => onDismiss();

    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("resize", handleScroll);

    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [target, onDismiss]);

  if (!target || !target.memo || target.memo.trim().length === 0) return null;

  const isOthers = target.coder !== target.activeCoder;

  return createPortal(
    <div
      ref={cardRef}
      role="tooltip"
      aria-label="Note preview"
      className="glass-card anim-rise pointer-events-none fixed z-[85] flex max-h-[260px] w-[300px] flex-col overflow-hidden p-3.5 shadow-xl select-none"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        boxShadow: "var(--shadow-2)",
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium text-white shadow-sm"
          style={{ backgroundColor: target.code.color }}
        >
          {target.code.name}
        </span>
        {isOthers && (
          <span className="text-[10.5px] font-medium text-[var(--ink-3)]">
            {target.coder}
          </span>
        )}
      </div>

      <div className="overflow-y-auto pr-1 space-y-2">
        {target.quote && (
          <p className="font-serif text-[12px] italic leading-snug text-[var(--ink-2)] border-l-2 border-[var(--g-rim)] pl-2">
            “{target.quote}”
          </p>
        )}

        <p className="text-[12.5px] leading-relaxed text-[var(--ink)] whitespace-pre-wrap">
          {target.memo}
        </p>
      </div>
    </div>,
    document.body,
  );
}
