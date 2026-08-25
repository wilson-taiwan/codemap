import type { CodedSegment } from "./types";

export function computeInterviewCodedCount(
  codedSegments: CodedSegment[],
): number {
  const segmentIds = new Set<string>();
  for (const c of codedSegments) segmentIds.add(c.segment_id);
  return segmentIds.size;
}
