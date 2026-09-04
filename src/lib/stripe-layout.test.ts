import { describe, expect, it } from "vitest";
import {
  computeStripeLayout,
  mergeAdjacentRects,
  MAX_STRIPE_COLUMNS,
  getStripeGutterGeometry,
} from "./stripe-layout";
import type { Code, CodedSegment } from "./types";

function mockCode(partial: Partial<Code> & { id: string; name: string; color: string }): Code {
  return {
    definition: "",
    inclusion_criteria: "",
    exclusion_criteria: "",
    example: "",
    parent_id: null,
    sort_order: 0,
    is_retired: false,
    usage_count: 0,
    ...partial,
  };
}

function mockCodedSegment(partial: Partial<CodedSegment> & { id: string; code_ids: string[] }): CodedSegment {
  return {
    interview_id: "iv1",
    segment_id: "s1",
    coder_name: "Ada",
    char_start: null,
    char_end: null,
    memo: null,
    quote_text: "quote",
    block_id: "b1",
    timestamp_start: "00:00",
    participant_label: "P01",
    ...partial,
  };
}

describe("stripe-layout", () => {
  const codes: Code[] = [
    mockCode({ id: "c1", name: "Code A", color: "#ff0000", sort_order: 1 }),
    mockCode({ id: "c2", name: "Code B", color: "#00ff00", sort_order: 2 }),
    mockCode({ id: "c3", name: "Code C", color: "#0000ff", sort_order: 3 }),
    mockCode({ id: "c4", name: "Code D", color: "#ffff00", sort_order: 4 }),
    mockCode({ id: "c5", name: "Code E", color: "#ff00ff", sort_order: 5 }),
    mockCode({ id: "c6", name: "Code F", color: "#00ffff", sort_order: 6 }),
  ];
  const codesById = new Map(codes.map((c) => [c.id, c]));

  it("assigns columns consistently by sort_order", () => {
    const coded: CodedSegment[] = [
      mockCodedSegment({
        id: "cs1",
        code_ids: ["c3", "c1"],
        coder_name: "Ada",
      }),
    ];

    const result = computeStripeLayout({
      coded,
      codesById,
      activeCoder: "Ada",
      codeFilter: null,
      passageHeight: 100,
    });

    expect(result.columns.length).toBe(2);
    expect(result.columns[0].codeId).toBe("c1"); // sort_order 1
    expect(result.columns[1].codeId).toBe("c3"); // sort_order 3
    expect(result.overflowCount).toBe(0);

    expect(result.stripes.length).toBe(2);
    const stripeA = result.stripes.find((s) => s.codeId === "c1")!;
    const stripeC = result.stripes.find((s) => s.codeId === "c3")!;
    expect(stripeA.columnIndex).toBe(0);
    expect(stripeC.columnIndex).toBe(1);
    expect(stripeA.isDashed).toBe(false);
  });

  it("caps visible columns at 5 and provides overflow info", () => {
    const coded: CodedSegment[] = [
      mockCodedSegment({
        id: "cs1",
        code_ids: ["c1", "c2", "c3", "c4", "c5", "c6"],
        coder_name: "Ada",
      }),
    ];

    const result = computeStripeLayout({
      coded,
      codesById,
      activeCoder: "Ada",
      codeFilter: null,
      passageHeight: 100,
    });

    expect(result.columns.length).toBe(MAX_STRIPE_COLUMNS);
    expect(result.overflowCount).toBe(1);
    expect(result.overflowCodes[0].id).toBe("c6");
    expect(result.stripes.some((s) => s.codeId === "c6")).toBe(false);
  });

  it("marks other coders as dashed stripes", () => {
    const coded: CodedSegment[] = [
      mockCodedSegment({
        id: "cs1",
        code_ids: ["c1"],
        coder_name: "Luci",
      }),
    ];

    const result = computeStripeLayout({
      coded,
      codesById,
      activeCoder: "Ada",
      codeFilter: null,
      passageHeight: 100,
    });

    expect(result.stripes[0].isDashed).toBe(true);
  });

  it("filters to a single code column when codeFilter is active", () => {
    const coded: CodedSegment[] = [
      mockCodedSegment({
        id: "cs1",
        code_ids: ["c1", "c2"],
        coder_name: "Ada",
      }),
    ];

    const result = computeStripeLayout({
      coded,
      codesById,
      activeCoder: "Ada",
      codeFilter: "c2",
      passageHeight: 100,
    });

    expect(result.columns.length).toBe(1);
    expect(result.columns[0].codeId).toBe("c2");
    expect(result.stripes.length).toBe(1);
    expect(result.stripes[0].codeId).toBe("c2");
    expect(result.stripes[0].columnIndex).toBe(0);
  });

  it("merges adjacent and overlapping rects properly", () => {
    const input = [
      { top: 10, height: 15 },
      { top: 25, height: 15 }, // adjacent
      { top: 50, height: 10 },
      { top: 55, height: 10 }, // overlapping
    ];

    const merged = mergeAdjacentRects(input);
    expect(merged).toEqual([
      { top: 10, height: 30 },
      { top: 50, height: 15 },
    ]);
  });

  it("calculates gutter geometry with clearance to text and pills", () => {
    const geo = getStripeGutterGeometry();
    expect(geo.gutterWidth).toBe(28);
    expect(geo.textInset).toBe(32);
    expect(geo.maxStripeRight).toBe(23);
    expect(geo.clearanceToText).toBe(9);
    expect(geo.fitsInGutter).toBe(true);
  });
});
