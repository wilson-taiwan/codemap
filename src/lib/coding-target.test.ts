import { describe, expect, it } from "vitest";
import { resolveClickedCoding } from "./coding-target";
import type { CodedSegment } from "./types";

function mockCoding(partial: Partial<CodedSegment>): CodedSegment {
  return {
    id: "cs-1",
    interview_id: "iv-1",
    segment_id: "seg-1",
    code_ids: ["c1"],
    coder_name: "Ada",
    char_start: null,
    char_end: null,
    memo: null,
    quote_text: "",
    block_id: "b1",
    timestamp_start: "00:00",
    participant_label: "P01",
    ...partial,
  };
}

describe("resolveClickedCoding", () => {
  it("returns null when no codings exist", () => {
    expect(resolveClickedCoding([], 10)).toBeNull();
  });

  it("selects the span containing click offset", () => {
    const spanCoding = mockCoding({ id: "span1", char_start: 10, char_end: 25 });
    const result = resolveClickedCoding([spanCoding], 15);
    expect(result?.id).toBe("span1");
  });

  it("selects at boundary offsets (inclusive start and end)", () => {
    const spanCoding = mockCoding({ id: "span1", char_start: 10, char_end: 25 });
    expect(resolveClickedCoding([spanCoding], 10)?.id).toBe("span1");
    expect(resolveClickedCoding([spanCoding], 25)?.id).toBe("span1");
  });

  it("prefers the narrower span when spans overlap", () => {
    const wideSpan = mockCoding({ id: "wide", char_start: 5, char_end: 40 });
    const narrowSpan = mockCoding({ id: "narrow", char_start: 12, char_end: 20 });
    const result = resolveClickedCoding([wideSpan, narrowSpan], 15);
    expect(result?.id).toBe("narrow");
  });

  it("falls back to whole-turn coding when click offset is outside any span", () => {
    const span = mockCoding({ id: "span", char_start: 10, char_end: 20 });
    const wholeTurn = mockCoding({ id: "whole", char_start: null, char_end: null });
    const result = resolveClickedCoding([span, wholeTurn], 35);
    expect(result?.id).toBe("whole");
  });

  it("whole-turn loses to any span containing the click offset", () => {
    const span = mockCoding({ id: "span", char_start: 10, char_end: 20 });
    const wholeTurn = mockCoding({ id: "whole", char_start: null, char_end: null });
    const result = resolveClickedCoding([span, wholeTurn], 15);
    expect(result?.id).toBe("span");
  });

  it("returns whole-turn coding when clickOffset is null", () => {
    const wholeTurn = mockCoding({ id: "whole", char_start: null, char_end: null });
    expect(resolveClickedCoding([wholeTurn], null)?.id).toBe("whole");
  });
});
