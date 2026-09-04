import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Code } from "../lib/types";
import { computeNotePlacement } from "../lib/note-placement";
import { Icon } from "./ui/Icon";

export interface NoteHoverCardTarget {
  element: HTMLElement;
  code: Code;
  quote: string;
  memo: string;
  coder: string;
  activeCoder: string;
  segmentId?: string;
  pinned?: boolean;
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

  const place = useCallback(() => {
    if (!target) {
      setPos(null);
      return;
    }
    const card = cardRef.current;
    if (!card) return;

    // Anchor to the reading column / passage if segmentId is present
    const passageEl = target.segmentId
      ? (document.getElementById(`segment-${target.segmentId}`) ??
         document.querySelector(`[data-segment-id="${target.segmentId}"]`))
      : null;
    const targetEl = passageEl
      ? (passageEl.querySelector("[data-passage-copy]") as HTMLElement) ?? passageEl
      : target.element;

    const rowRect = targetEl.getBoundingClientRect();
    const scroller = document.querySelector('[data-testid="transcript-scroller"]');
    const scrollerRect = scroller
      ? scroller.getBoundingClientRect()
      : {
          top: 0,
          bottom: window.innerHeight,
          left: 0,
          right: window.innerWidth,
          width: window.innerWidth,
          height: window.innerHeight,
        };

    const cardHeight = card.offsetHeight || 160;
    const computed = computeNotePlacement({
      rowRect,
      scrollerRect,
      cardHeight,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    });

    setPos({ top: computed.top, left: computed.left });
  }, [target]);

  // Position before paint, track scroll/resize, and observe element size
  useLayoutEffect(() => {
    if (!target) {
      setPos(null);
      return;
    }
    place();
    const scroller = document.querySelector('[data-testid="transcript-scroller"]');
    scroller?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    const card = cardRef.current;
    let observer: ResizeObserver | null = null;
    if (card) {
      observer = new ResizeObserver(place);
      observer.observe(card);
    }
    return () => {
      scroller?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      observer?.disconnect();
    };
  }, [target, place]);

  // Dismiss listeners: pinned notes stay open across scroll and background mousedown;
  // Esc closes pinned note and returns focus to the usage row.
  useEffect(() => {
    if (!target) return;

    if (target.pinned) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDismiss();
          target.element.focus();
        }
      };
      window.addEventListener("keydown", handleKeyDown, true);
      return () => window.removeEventListener("keydown", handleKeyDown, true);
    }

    // Preview mode: dismiss on scroll or background click
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
  const isPinned = Boolean(target.pinned);

  return createPortal(
    <div
      ref={cardRef}
      role={isPinned ? "dialog" : "tooltip"}
      aria-label={isPinned ? "Passage note" : "Note preview"}
      className={`note-card anim-rise fixed z-[85] flex max-h-[280px] w-[300px] flex-col overflow-hidden p-3.5 shadow-xl select-none ${
        isPinned ? "pointer-events-auto" : "pointer-events-none"
      }`}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
      }}
      onClick={(e) => isPinned && e.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium text-white shadow-sm shrink-0"
            style={{ backgroundColor: target.code.color }}
          >
            {target.code.name}
          </span>
          {isOthers && (
            <span className="text-[10.5px] font-medium text-[var(--ink-3)] truncate">
              {target.coder}
            </span>
          )}
        </div>

        {isPinned && (
          <button
            type="button"
            onClick={() => {
              onDismiss();
              target.element.focus();
            }}
            aria-label="Close note"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--ink-3)] hover:bg-[var(--fill)] hover:text-[var(--ink)]"
          >
            <Icon name="close" size={12} />
          </button>
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
