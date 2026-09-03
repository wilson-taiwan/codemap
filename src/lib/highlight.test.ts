import { describe, expect, it } from "vitest";
import { extendSpan, highlightRuns, trimmedSpan } from "./highlight";
import type { Code, CodedSegment } from "./types";

const TEXT = "I rehearse the hello on the drive in";

function code(id: string, sortOrder = 0): Code {
  return {
    id,
    name: id,
    definition: null,
    inclusion_criteria: null,
    exclusion_criteria: null,
    example: null,
    parent_id: null,
    color: "#888888",
    sort_order: sortOrder,
    is_retired: false,
    usage_count: 0,
  };
}

function coded(
  id: string,
  codeIds: string[],
  span: [number, number] | null,
  coder = "Ada",
): CodedSegment {
  return {
    id,
    interview_id: "iv",
    segment_id: "seg",
    code_ids: codeIds,
    coder_name: coder,
    memo: null,
    char_start: span ? span[0] : null,
    char_end: span ? span[1] : null,
    quote_text: "",
    block_id: null,
    timestamp_start: "00:00:00.000",
    participant_label: "P07",
  } as CodedSegment;
}

const CODES = new Map([
  ["a", code("a", 0)],
  ["b", code("b", 1)],
  ["c", code("c", 2)],
]);

describe("highlightRuns", () => {
  it("returns the whole passage as one plain run when nothing is coded", () => {
    const runs = highlightRuns(TEXT, [], CODES);
    expect(runs).toHaveLength(1);
    expect(runs[0].text).toBe(TEXT);
    expect(runs[0].codes).toEqual([]);
  });

  it("always tiles the passage exactly, whatever the spans", () => {
    const runs = highlightRuns(
      TEXT,
      [coded("1", ["a"], [2, 10]), coded("2", ["b"], [6, 20])],
      CODES,
    );
    expect(runs.map((r) => r.text).join("")).toBe(TEXT);
    expect(runs[0].start).toBe(0);
    expect(runs[runs.length - 1].end).toBe(TEXT.length);
  });

  it("reports every code covering an overlap, not just the first", () => {
    const runs = highlightRuns(
      TEXT,
      [coded("1", ["a"], [0, 12]), coded("2", ["b"], [6, 20])],
      CODES,
    );
    const overlap = runs.find((r) => r.start === 6 && r.end === 12);
    expect(overlap).toBeDefined();
    expect(overlap!.codes.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("splits three overlapping spans into five runs", () => {
    const runs = highlightRuns(
      TEXT,
      [
        coded("1", ["a"], [0, 20]),
        coded("2", ["b"], [5, 30]),
        coded("3", ["c"], [10, 25]),
      ],
      CODES,
    );
    expect(runs.map((r) => r.text).join("")).toBe(TEXT);
    // 0-5 a | 5-10 ab | 10-20 abc | 20-25 bc | 25-30 b | 30-end plain
    expect(runs.length).toBeGreaterThanOrEqual(5);
    const middle = runs.find((r) => r.start === 10 && r.end === 20);
    expect(middle!.codes.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("names both coders on a shared stretch", () => {
    const runs = highlightRuns(
      TEXT,
      [
        coded("1", ["a"], [0, 12], "Ada"),
        coded("2", ["a"], [0, 12], "Sam"),
      ],
      CODES,
    );
    const marked = runs.find((r) => r.codes.length > 0)!;
    expect(marked.coders).toEqual(["Ada", "Sam"]);
  });

  // ⚠️ This asserted the opposite until 0.16.0: whole-turn codings were
  // excluded from highlighting, so coding a whole passage left its text plain
  // and looked like nothing had been recorded. A code on a whole passage is a
  // claim about every word in it, and it now reads that way.
  it("draws a whole-turn coding across the entire passage", () => {
    const runs = highlightRuns(TEXT, [coded("1", ["a"], null)], CODES);
    expect(runs).toHaveLength(1);
    expect(runs[0].codes.map((c) => c.id)).toEqual(["a"]);
    expect(runs[0].start).toBe(0);
    expect(runs[0].end).toBe(TEXT.length);
    expect(runs[0].wholeTurnOnly).toBe(true);
  });

  it("keeps a span visible inside a whole-turn coding", () => {
    // The reason whole-turn codings were excluded was the fear of burying the
    // spans within them. Partitioning handles it: the middle run reports both
    // codes and is not flagged whole-turn-only, so it can be drawn stronger.
    const runs = highlightRuns(
      TEXT,
      [coded("1", ["a"], null), coded("2", ["b"], [5, 12])],
      CODES,
    );
    const inner = runs.find((r) => r.codes.length === 2)!;
    expect(inner.start).toBe(5);
    expect(inner.end).toBe(12);
    expect(inner.wholeTurnOnly).toBe(false);
    expect(runs.every((r) => r.codes.some((c) => c.id === "a"))).toBe(true);
  });

  it("merges touching spans that carry identical codes", () => {
    const runs = highlightRuns(
      TEXT,
      [coded("1", ["a"], [0, 10]), coded("2", ["a"], [10, 20])],
      CODES,
    );
    // One highlighted run 0-20, not two abutting ones with a seam mid-word.
    const marked = runs.filter((r) => r.codes.length > 0);
    expect(marked).toHaveLength(1);
    expect(marked[0].start).toBe(0);
    expect(marked[0].end).toBe(20);
  });

  it("clamps offsets that fall outside a re-imported passage", () => {
    const runs = highlightRuns(
      "short",
      [coded("1", ["a"], [2, 500])],
      CODES,
    );
    expect(runs.map((r) => r.text).join("")).toBe("short");
    expect(runs.every((r) => r.end <= 5)).toBe(true);
  });

  it("drops a span that inverts or collapses rather than dropping text", () => {
    const runs = highlightRuns(
      TEXT,
      [coded("1", ["a"], [10, 10]), coded("2", ["b"], [20, 5])],
      CODES,
    );
    expect(runs.map((r) => r.text).join("")).toBe(TEXT);
    expect(runs.every((r) => r.codes.length === 0)).toBe(true);
  });

  it("tracks unresolved code ids when codebook does not hold them", () => {
    const runs = highlightRuns(
      TEXT,
      [coded("1", ["a", "deleted-code"], [0, 10])],
      CODES,
    );
    const marked = runs.find((r) => r.start === 0 && r.end === 10)!;
    expect(marked.codes.map((c) => c.id)).toEqual(["a"]);
    expect(marked.unresolvedCount).toBe(1);
  });

  it("reports span covered with unresolvedCount when codesById is empty", () => {
    const runs = highlightRuns(
      TEXT,
      [coded("1", ["unknown-code-1", "unknown-code-2"], [0, 10], "Sam")],
      new Map(),
    );
    const marked = runs.find((r) => r.start === 0 && r.end === 10)!;
    expect(marked.codes).toEqual([]);
    expect(marked.unresolvedCount).toBe(2);
    expect(marked.coders).toEqual(["Sam"]);
  });

  it("formats run attribution with coder names, you-substitution, and unresolved counts", async () => {
    const codeA = code("a");
    codeA.name = "Apples";
    const codeB = code("b");
    codeB.name = "Oranges";
    const codesMap = new Map([
      ["a", codeA],
      ["b", codeB],
    ]);

    const runs = highlightRuns(
      TEXT,
      [
        coded("1", ["a"], [0, 10], "Ada"),
        coded("2", ["b"], [0, 10], "Sam"),
      ],
      codesMap,
    );
    const marked = runs.find((r) => r.start === 0 && r.end === 10)!;
    const { formatRunAttribution } = await import("./highlight");
    const attribution = formatRunAttribution(marked, "Ada");
    expect(attribution).toContain("Apples — you");
    expect(attribution).toContain("Oranges — Sam");
  });

  it("formats attribution when both coders applied the same code", async () => {
    const codeA = code("a");
    codeA.name = "Apples";
    const codesMap = new Map([["a", codeA]]);

    const runs = highlightRuns(
      TEXT,
      [
        coded("1", ["a"], [0, 10], "Ada"),
        coded("2", ["a"], [0, 10], "Sam"),
      ],
      codesMap,
    );
    const marked = runs.find((r) => r.start === 0 && r.end === 10)!;
    const { formatRunAttribution } = await import("./highlight");
    const attribution = formatRunAttribution(marked, "Ada");
    expect(attribution).toBe("Apples — you, Sam");
  });
});

describe("trimmedSpan", () => {
  it("keeps a clean selection exactly as dragged", () => {
    expect(trimmedSpan(11, "the hello")).toEqual({
      start: 11,
      end: 20,
      text: "the hello",
    });
  });

  it("trims a trailing space without shifting the start", () => {
    expect(trimmedSpan(0, "I rehearse ")).toEqual({
      start: 0,
      end: 10,
      text: "I rehearse",
    });
  });

  it("moves the start past a leading space", () => {
    expect(trimmedSpan(10, " the hello")).toEqual({
      start: 11,
      end: 20,
      text: "the hello",
    });
  });

  it("trims both edges at once", () => {
    expect(trimmedSpan(5, "  hello  ")).toEqual({
      start: 7,
      end: 12,
      text: "hello",
    });
  });

  it("rejects a whitespace-only or empty selection", () => {
    expect(trimmedSpan(4, "   ")).toBeNull();
    expect(trimmedSpan(4, "")).toBeNull();
  });

  it("keeps the reported text and the offsets describing the same stretch", () => {
    const passage = "I rehearse the hello on the drive in";
    for (const [from, len] of [[0, 11], [2, 14], [10, 12], [20, 16]] as const) {
      const raw = passage.slice(from, from + len);
      const span = trimmedSpan(from, raw);
      if (!span) continue;
      expect(passage.slice(span.start, span.end)).toBe(span.text);
    }
  });
});

describe("extendSpan", () => {
  const PASSAGE = "I rehearse the hello on the drive in";

  it("extends forward from the anchor to the click point", () => {
    // Dragged "rehearse" (2-9), Shift+click at 20: covers 2-20 trimmed.
    expect(extendSpan(PASSAGE, 2, 20)).toEqual({
      start: 2,
      end: 20,
      text: PASSAGE.slice(2, 20),
    });
  });

  it("flips the edges when the click lands before the anchor", () => {
    expect(extendSpan(PASSAGE, 20, 2)).toEqual({
      start: 2,
      end: 20,
      text: PASSAGE.slice(2, 20),
    });
  });

  it("keeps the anchor edge fixed and trims like a drag", () => {
    // Click lands on the trailing space of "hello ": the end trims back.
    const span = extendSpan(PASSAGE, 11, 17);
    expect(span).toEqual(trimmedSpan(11, PASSAGE.slice(11, 17)));
    expect(span?.start).toBe(11);
  });

  it("matches trimmedSpan parity across the passage", () => {
    for (const [anchor, focus] of [[0, 11], [2, 14], [10, 12], [20, 16], [16, 20]] as const) {
      const span = extendSpan(PASSAGE, anchor, focus);
      const parity = trimmedSpan(
        Math.min(anchor, focus),
        PASSAGE.slice(Math.min(anchor, focus), Math.max(anchor, focus)),
      );
      expect(span).toEqual(parity);
      if (span) expect(PASSAGE.slice(span.start, span.end)).toBe(span.text);
    }
  });

  it("rejects a click on the anchor and whitespace-only ranges", () => {
    expect(extendSpan(PASSAGE, 9, 9)).toBeNull();
    // 9-11 is " h" — trims to "h", kept. 10-11 is just " " — rejected.
    expect(extendSpan(PASSAGE, 10, 11)).toBeNull();
  });

  it("clamps out-of-range offsets to the passage", () => {
    const span = extendSpan(PASSAGE, -5, 999);
    expect(span?.start).toBe(0);
    expect(span?.end).toBe(PASSAGE.length);
  });
});

describe("matchRanges", () => {
  it("returns empty array for empty query or whitespace", async () => {
    const { matchRanges } = await import("./highlight");
    expect(matchRanges(TEXT, "")).toEqual([]);
    expect(matchRanges(TEXT, "   ")).toEqual([]);
  });

  it("finds match at passage start", async () => {
    const { matchRanges } = await import("./highlight");
    expect(matchRanges(TEXT, "I rehearse")).toEqual([{ start: 0, end: 10 }]);
  });

  it("finds match at passage end", async () => {
    const { matchRanges } = await import("./highlight");
    expect(matchRanges(TEXT, "drive in")).toEqual([{ start: 28, end: 36 }]);
  });

  it("finds adjacent matches", async () => {
    const { matchRanges } = await import("./highlight");
    expect(matchRanges("ha ha ha", "ha")).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 8 },
    ]);
  });
});

describe("splitRunsOnMatches", () => {
  it("leaves runs unchanged when there are no matches and no pending selection", async () => {
    const { highlightRuns, splitRunsOnMatches } = await import("./highlight");
    const runs = highlightRuns(TEXT, [], CODES);
    const pieces = splitRunsOnMatches(runs, TEXT);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].text).toBe(TEXT);
    expect(pieces[0].isMatch).toBe(false);
    expect(pieces[0].isCurrentMatch).toBe(false);
    expect(pieces[0].pending).toBe(false);
  });

  it("splits a match entirely inside a coded run while preserving code and attribution", async () => {
    const { highlightRuns, matchRanges, splitRunsOnMatches } = await import("./highlight");
    // "I rehearse the hello on the drive in"
    // coded "the hello" = [11, 20]
    const runs = highlightRuns(TEXT, [coded("1", ["a"], [11, 20])], CODES);
    // search for "hello" = [15, 20]
    const matches = matchRanges(TEXT, "hello");
    const pieces = splitRunsOnMatches(runs, TEXT, { matches, currentMatch: matches[0] });

    expect(pieces.map((p) => p.text).join("")).toBe(TEXT);

    const matchPiece = pieces.find((p) => p.isMatch);
    expect(matchPiece).toBeDefined();
    expect(matchPiece!.text).toBe("hello");
    expect(matchPiece!.start).toBe(15);
    expect(matchPiece!.end).toBe(20);
    expect(matchPiece!.codes.map((c) => c.id)).toEqual(["a"]);
    expect(matchPiece!.isCurrentMatch).toBe(true);
  });

  it("splits a match that spans across a run boundary (uncoded to coded)", async () => {
    const { highlightRuns, matchRanges, splitRunsOnMatches } = await import("./highlight");
    // coded [11, 20] ("the hello")
    const runs = highlightRuns(TEXT, [coded("1", ["a"], [11, 20])], CODES);
    // search "rehearse the" = [2, 14] -> spans run 1 [0, 11] and run 2 [11, 20]
    const matches = matchRanges(TEXT, "rehearse the");
    const pieces = splitRunsOnMatches(runs, TEXT, { matches });

    expect(pieces.map((p) => p.text).join("")).toBe(TEXT);
    const matchPieces = pieces.filter((p) => p.isMatch);
    expect(matchPieces).toHaveLength(2);
    expect(matchPieces[0].text).toBe("rehearse ");
    expect(matchPieces[0].codes).toEqual([]);
    expect(matchPieces[1].text).toBe("the");
    expect(matchPieces[1].codes.map((c) => c.id)).toEqual(["a"]);
  });

  it("handles overlapping query and code edges cleanly", async () => {
    const { highlightRuns, matchRanges, splitRunsOnMatches } = await import("./highlight");
    // coded [11, 20] ("the hello")
    const runs = highlightRuns(TEXT, [coded("1", ["a"], [11, 20])], CODES);
    // search "hello on" = [15, 23]
    const matches = matchRanges(TEXT, "hello on");
    const pieces = splitRunsOnMatches(runs, TEXT, { matches });

    expect(pieces.map((p) => p.text).join("")).toBe(TEXT);
    const matchPieces = pieces.filter((p) => p.isMatch);
    expect(matchPieces).toHaveLength(2);
    expect(matchPieces[0].text).toBe("hello");
    expect(matchPieces[0].codes.map((c) => c.id)).toEqual(["a"]);
    expect(matchPieces[1].text).toBe(" on");
    expect(matchPieces[1].codes).toEqual([]);
  });

  it("preserves pending selection split on uncoded runs", async () => {
    const { highlightRuns, splitRunsOnMatches } = await import("./highlight");
    const runs = highlightRuns(TEXT, [], CODES);
    const pieces = splitRunsOnMatches(runs, TEXT, {
      pending: { start: 2, end: 10 },
    });
    expect(pieces.map((p) => p.text).join("")).toBe(TEXT);
    const pendingPiece = pieces.find((p) => p.pending);
    expect(pendingPiece).toBeDefined();
    expect(pendingPiece!.text).toBe("rehearse");
  });
});
