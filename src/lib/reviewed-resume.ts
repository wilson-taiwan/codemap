import type { TranscriptSegment } from "./types";

/**
 * Pure helper to locate the first unreviewed segment.
 * Empty or fully reviewed input returns the first segment id, or null when no segments exist.
 */
export function firstUnreviewedSegmentId(
  segments: TranscriptSegment[],
  reviewedBySegment: Record<string, boolean>,
): string | null {
  if (segments.length === 0) return null;
  const unreviewed = segments.find((s) => !reviewedBySegment[s.id]);
  return unreviewed ? unreviewed.id : segments[0].id;
}
