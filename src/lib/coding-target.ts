import type { CodedSegment } from "./types";

/**
 * Resolves which coding a click in a passage refers to.
 * When multiple coded spans contain the offset, prefers the narrowest span.
 * If no span contains the offset, falls back to a whole-turn coding (if present).
 * If no coding matches, returns null.
 */
export function resolveClickedCoding(
  codings: CodedSegment[],
  clickOffset: number | null,
): CodedSegment | null {
  if (codings.length === 0) return null;

  if (clickOffset !== null) {
    const containingSpans = codings.filter((c) => {
      if (c.char_start == null || c.char_end == null) return false;
      return c.char_start <= clickOffset && clickOffset <= c.char_end;
    });

    if (containingSpans.length > 0) {
      // Narrowest span wins (shortest character length)
      containingSpans.sort((a, b) => {
        const lenA = (a.char_end ?? 0) - (a.char_start ?? 0);
        const lenB = (b.char_end ?? 0) - (b.char_start ?? 0);
        return lenA - lenB;
      });
      return containingSpans[0];
    }
  }

  // Fallback to whole-turn coding if present
  const wholeTurn = codings.find(
    (c) => c.char_start == null && c.char_end == null,
  );
  return wholeTurn ?? null;
}
