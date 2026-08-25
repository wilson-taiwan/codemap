import { describe, expect, it, vi } from "vitest";
import { codingsCoveringRun, buildMarkMenuItems } from "./TranscriptPanel.menu";
import type { Code, CodedSegment } from "../lib/types";

describe("TranscriptPanel.menu helpers", () => {
  const codes: Code[] = [
    {
      id: "code-1",
      name: "Masking",
      definition: null,
      inclusion_criteria: null,
      exclusion_criteria: null,
      example: null,
      parent_id: null,
      color: "#8a6410",
      sort_order: 1,
      is_retired: false,
      usage_count: 5,
    },
    {
      id: "code-2",
      name: "Fatigue",
      definition: null,
      inclusion_criteria: null,
      exclusion_criteria: null,
      example: null,
      parent_id: null,
      color: "#1f7a5e",
      sort_order: 2,
      is_retired: false,
      usage_count: 3,
    },
  ];

  const codesById = new Map(codes.map((c) => [c.id, c]));

  const codedSegments: CodedSegment[] = [
    {
      id: "coding-mine-1",
      interview_id: "iv-1",
      segment_id: "seg-1",
      code_ids: ["code-1"],
      coder_name: "Ada",
      memo: "Interesting reflection",
      char_start: 10,
      char_end: 30,
      quote_text: "masked in public",
      block_id: null,
      timestamp_start: "00:01:00",
      participant_label: "P01",
    },
    {
      id: "coding-theirs-1",
      interview_id: "iv-1",
      segment_id: "seg-1",
      code_ids: ["code-2"],
      coder_name: "Hiroko",
      memo: "Colleague observation",
      char_start: 5,
      char_end: 35,
      quote_text: "always masked in public setting",
      block_id: null,
      timestamp_start: "00:01:00",
      participant_label: "P01",
    },
  ];

  it("partitions matching runs into mine and theirs", () => {
    const run = { start: 12, end: 25 };
    const { mine, theirs } = codingsCoveringRun("seg-1", run, codedSegments, "Ada");

    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe("coding-mine-1");
    expect(theirs).toHaveLength(1);
    expect(theirs[0].id).toBe("coding-theirs-1");
  });

  it("builds 4 actions for active coder's coding and filter-only for colleague", () => {
    const run = { start: 12, end: 25 };
    const setCodeFilter = vi.fn();
    const openNoteFor = vi.fn();
    const removeCodeFromCoding = vi.fn();
    const clearMemoForCoding = vi.fn();

    const items = buildMarkMenuItems({
      segmentId: "seg-1",
      run,
      codedSegments,
      codesById,
      activeCoder: "Ada",
      codeFilter: null,
      setCodeFilter,
      openNoteFor,
      removeCodeFromCoding,
      clearMemoForCoding,
    });

    const labels = items.map((i) => i.label);
    expect(labels).toContain('Filter by "Masking"');
    expect(labels).toContain("Edit note");
    expect(labels).toContain("Remove note");
    expect(labels).toContain('Remove "Masking"');

    // Colleague items
    expect(labels).toContain('Filter by "Fatigue"');
    const colleagueItem = items.find((i) => i.label === 'Filter by "Fatigue"');
    expect(colleagueItem?.section).toBe("Hiroko");
  });
});
