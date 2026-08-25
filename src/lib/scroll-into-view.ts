export type SelectIntent = "click" | "keys" | "jump" | "restore";

export const SCROLL_MARGIN = 48;

export interface ScrollPlanInput {
  elTop: number;
  elHeight: number;
  scrollTop: number;
  viewportHeight: number;
  intent: SelectIntent;
}

/**
 * Returns the scrollTop to animate to, or null to stay put.
 */
export function scrollPlan({
  elTop,
  elHeight,
  scrollTop,
  viewportHeight,
  intent,
}: ScrollPlanInput): number | null {
  // 1. intent === "restore" → centre, as today
  if (intent === "restore") {
    return Math.max(0, elTop - viewportHeight / 2 + elHeight / 2);
  }

  // 2. intent === "jump" → centre, as today
  if (intent === "jump") {
    return Math.max(0, elTop - viewportHeight / 2 + elHeight / 2);
  }

  const viewportTop = scrollTop;
  const viewportBottom = scrollTop + viewportHeight;

  // 3. Element taller than viewportHeight:
  if (elHeight >= viewportHeight) {
    const isPartiallyVisible =
      (elTop >= viewportTop && elTop < viewportBottom) ||
      (elTop + elHeight > viewportTop && elTop + elHeight <= viewportBottom) ||
      (elTop <= viewportTop && elTop + elHeight >= viewportBottom);
    if (isPartiallyVisible) {
      return null;
    }
    return Math.max(0, elTop - SCROLL_MARGIN);
  }

  // 4. Otherwise, fully visible within SCROLL_MARGIN of both edges → null
  const visibleTop = viewportTop + SCROLL_MARGIN;
  const visibleBottom = viewportBottom - SCROLL_MARGIN;
  const isFullyVisibleWithinMargins =
    elTop >= visibleTop && elTop + elHeight <= visibleBottom;

  if (isFullyVisibleWithinMargins) {
    return null;
  }

  // 5. Otherwise, scroll to the nearest edge:
  // If element is above
  if (elTop < visibleTop) {
    return Math.max(0, elTop - SCROLL_MARGIN);
  }

  // If element is below
  return Math.max(0, elTop + elHeight - viewportHeight + SCROLL_MARGIN);
}
