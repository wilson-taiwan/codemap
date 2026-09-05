import { describe, expect, it } from "vitest";
import { firstUnreviewedSegmentId } from "./reviewed-resume";
import type { TranscriptSegment } from "./types";

function mockSeg(id: string, segment_index: number): TranscriptSegment {
  return {
    id,
    interview_id: "iv-1",
    segment_index,
    speaker: "Speaker 1",
    timestamp_start: "00:00:00",
    timestamp_end: null,
    text: `Segment ${segment_index}`,
    block_id: null,
    section_tag: null,
  };
}

describe("firstUnreviewedSegmentId", () => {
  it("returns null when segments list is empty", () => {
    expect(firstUnreviewedSegmentId([], {})).toBeNull();
  });

  it("returns first segment id when none are reviewed", () => {
    const segs = [mockSeg("s1", 0), mockSeg("s2", 1), mockSeg("s3", 2)];
    expect(firstUnreviewedSegmentId(segs, {})).toBe("s1");
  });

  it("returns the first gap when a middle segment is unreviewed", () => {
    const segs = [mockSeg("s1", 0), mockSeg("s2", 1), mockSeg("s3", 2)];
    expect(firstUnreviewedSegmentId(segs, { s1: true })).toBe("s2");
    expect(firstUnreviewedSegmentId(segs, { s1: true, s3: true })).toBe("s2");
  });

  it("returns the first segment id when all segments are reviewed", () => {
    const segs = [mockSeg("s1", 0), mockSeg("s2", 1), mockSeg("s3", 2)];
    expect(firstUnreviewedSegmentId(segs, { s1: true, s2: true, s3: true })).toBe("s1");
  });
});
