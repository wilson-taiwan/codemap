import { useEffect, type RefObject } from "react";

/**
 * Focus management for a modal surface: initial focus, a tab trap, and
 * restoring focus to whatever opened it.
 *
 * 🔑 Written because `Modal` and `SideSheet` bound Escape and nothing else.
 * There were three `focus()` calls in the entire codebase, all in one panel.
 * Opening a dialog left focus on the element behind it, so Tab walked the
 * page *underneath* the scrim — for a screen reader user the dialog may as
 * well not have opened, and for a keyboard user the first Tab went somewhere
 * invisible.
 *
 * `aria-modal="true"` was already set on both. That attribute is a promise to
 * assistive technology that focus is contained; it was not, and this makes it
 * true rather than removing the claim.
 */

const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export function useFocusTrap(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;

    // Remember where focus came from *before* moving it. Restoring to the
    // trigger is what makes a dialog feel like a detour rather than a
    // teleport: close it and you are back where you were.
    const returnTo =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Prefer the first real control; fall back to the dialog itself so focus
    // is at least inside. A dialog with no focusable content still needs to
    // be announced, which requires focus to land on it.
    const first = focusable(root)[0];
    if (first) first.focus();
    else {
      root.setAttribute("tabindex", "-1");
      root.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusable(root);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and pull focus back in if it has escaped — which
      // it can, since the scrim button is a sibling rather than a child.
      if (e.shiftKey && (active === firstItem || !root.contains(active))) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (active === lastItem || !root.contains(active))) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Only take focus back if it is still somewhere in the closing dialog.
      // Closing an action that deliberately moved focus elsewhere must win.
      if (!returnTo) return;
      const active = document.activeElement;
      if (active === document.body || (root && root.contains(active))) {
        returnTo.focus();
      }
    };
  }, [open, ref]);
}
