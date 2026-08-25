import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { MenuRow, useMenuKeys, type MenuItemSpec } from "./Menu";

interface ContextMenuState {
  items: MenuItemSpec[];
  x: number;
  y: number;
  open: boolean;
  openAt: (x: number, y: number, items: MenuItemSpec[]) => void;
  close: () => void;
}

const useContextMenuStore = create<ContextMenuState>((set) => ({
  items: [],
  x: 0,
  y: 0,
  open: false,
  openAt: (x, y, items) => set({ x, y, items, open: true }),
  close: () => set({ open: false, items: [] }),
}));

/**
 * Open a right-click menu at the pointer.
 *
 * Call from an element's `onContextMenu`. Pass an empty item list to fall
 * through to the webview's own menu — which is what text fields want, since
 * that native menu is where Cut/Copy/Paste live.
 */
export function openContextMenu(
  e: React.MouseEvent,
  items: MenuItemSpec[],
) {
  if (items.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  useContextMenuStore.getState().openAt(e.clientX, e.clientY, items);
}

/**
 * The single live context menu. Mount once near the app root.
 *
 * Portalled to `document.body` for the same reason dialogs are: six classes in
 * this app set `backdrop-filter`, and that makes an element a containing block
 * for fixed-position descendants, so a menu rendered inside a glass rail would
 * be clamped to that rail.
 */
export function ContextMenuHost() {
  const { items, x, y, open, close } = useContextMenuStore();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Measure after paint and pull the menu back inside the viewport. Opening
  // near the right or bottom edge is the common case, not the exception.
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    });
  }, [open, x, y, items]);

  const onMenuKeys = useMenuKeys(ref, close);

  // Same as the overflow menu: focus the first row so the very next key press
  // works, and so there is something visible to move from.
  useEffect(() => {
    if (!open) return;
    ref.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, [open, items]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    // `true` on mousedown so a click anywhere dismisses before it activates
    // something else; scroll and resize invalidate the anchor entirely.
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, close]);

  if (!open || items.length === 0) return null;

  const hasSections = items.some((i) => i.section);

  if (hasSections) {
    const sections: { title?: string; items: MenuItemSpec[] }[] = [];
    let currentSection: { title?: string; items: MenuItemSpec[] } | null = null;

    for (const item of items) {
      if (!currentSection || currentSection.title !== item.section) {
        currentSection = { title: item.section, items: [] };
        sections.push(currentSection);
      }
      currentSection.items.push(item);
    }

    return createPortal(
      <div
        ref={ref}
        role="menu"
        aria-label="Context menu"
        onKeyDown={onMenuKeys}
        className="glass-pop anim-rise fixed z-[60] min-w-52 p-1.5"
        style={{ left: pos.left, top: pos.top }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {sections.map((sec, sIdx) => (
          <div key={sec.title ?? sIdx} className={sIdx > 0 ? "mt-1.5 pt-1.5 border-t border-[var(--g-rim)]" : ""}>
            {sec.title && (
              <div className="eyebrow px-2 py-1 text-[10.5px] text-[var(--ink-3)] font-medium">
                {sec.title}
              </div>
            )}
            {sec.items.map((item) => (
              <MenuRow key={`${sec.title ?? ""}-${item.label}`} item={item} onDone={close} />
            ))}
          </div>
        ))}
      </div>,
      document.body,
    );
  }

  const primary = items.filter((i) => !i.destructive);
  const destructive = items.filter((i) => i.destructive);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Context menu"
      onKeyDown={onMenuKeys}
      className="glass-pop anim-rise fixed z-[60] min-w-52 p-1.5"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {primary.map((item) => (
        <MenuRow key={item.label} item={item} onDone={close} />
      ))}
      {destructive.length > 0 && (
        <>
          {primary.length > 0 && <div className="divider my-1.5" />}
          {destructive.map((item) => (
            <MenuRow key={item.label} item={item} onDone={close} />
          ))}
        </>
      )}
    </div>,
    document.body,
  );
}
