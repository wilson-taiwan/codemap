import { describe, expect, it } from "vitest";
import {
  buildFrameworkMatrix,
  generateFrameworkMatrixCsv,
} from "./framework-matrix";
import type { Code, CodedSegment, Interview } from "./types";

describe("framework-matrix", () => {
  const codes: Code[] = [
    {
      id: "c1",
      name: "Coping Strategy",
      definition: null,
      inclusion_criteria: null,
      exclusion_criteria: null,
      example: null,
      parent_id: null,
      color: "#8a6410",
      sort_order: 0,
      is_retired: false,
      usage_count: 2,
    },
    {
      id: "c1_1",
      name: "Rehearsal",
      definition: null,
      inclusion_criteria: null,
      exclusion_criteria: null,
      example: null,
      parent_id: "c1",
      color: "#8a6410",
      sort_order: 1,
      is_retired: false,
      usage_count: 1,
    },
    {
      id: "c2",
      name: "Exhaustion",
      definition: null,
      inclusion_criteria: null,
      exclusion_criteria: null,
      example: null,
      parent_id: null,
      color: "#1f7a5e",
      sort_order: 2,
      is_retired: false,
      usage_count: 1,
    },
  ];

  const interviews: Interview[] = [
    {
      id: "iv-1",
      participant_label: "P01",
      interview_date: "2026-03-11",
      modality: "zoom",
      diagnosis_notes: null,
      interviewers: ["Ada Lovelace"],
      hub_memo: null,
      audio_path: null,
      segment_count: 10,
      remote_segment_count: null,
    },
    {
      id: "iv-2",
      participant_label: "P02",
      interview_date: "2026-03-12",
      modality: "zoom",
      diagnosis_notes: null,
      interviewers: ["Ada Lovelace"],
      hub_memo: null,
      audio_path: null,
      segment_count: 5,
      remote_segment_count: null,
    },
  ];

  const codedSegments: CodedSegment[] = [
    {
      id: "cs1",
      interview_id: "iv-1",
      segment_id: "seg-1",
      code_ids: ["c1"],
      coder_name: "Ada Lovelace",
      memo: "General coping",
      char_start: null,
      char_end: null,
      quote_text: "I try to adapt to everyone.",
      block_id: null,
      timestamp_start: "00:01:00.000",
      participant_label: "P01",
    },
    {
      id: "cs2",
      interview_id: "iv-1",
      segment_id: "seg-2",
      code_ids: ["c1_1"],
      coder_name: "Ada Lovelace",
      memo: null,
      char_start: null,
      char_end: null,
      quote_text: "I practice my lines before meetings.",
      block_id: null,
      timestamp_start: "00:02:00.000",
      participant_label: "P01",
    },
    {
      id: "cs3",
      interview_id: "iv-2",
      segment_id: "seg-3",
      code_ids: ["c2"],
      coder_name: "Luci Diaz",
      memo: "Tiredness",
      char_start: null,
      char_end: null,
      quote_text: "By Friday I collapse.",
      block_id: null,
      timestamp_start: "00:05:00.000",
      participant_label: "P02",
    },
  ];

  it("builds matrix with sub-code rollup and participant rows", () => {
    const matrix = buildFrameworkMatrix(codes, interviews, codedSegments);

    expect(matrix.columns.map((c) => c.codeName)).toEqual([
      "Coping Strategy",
      "Exhaustion",
    ]);

    expect(matrix.rows).toHaveLength(2);

    // P01 has Coping Strategy (1 direct + 1 sub-code Rehearsal = 2)
    const p1Coping = matrix.rows[0].cells["c1"];
    expect(p1Coping.count).toBe(2);
    expect(p1Coping.snippets).toHaveLength(2);
    expect(p1Coping.snippets[0].quote).toBe("I try to adapt to everyone.");
    expect(p1Coping.snippets[1].subCodeName).toBe("Rehearsal");

    // P01 has 0 Exhaustion
    expect(matrix.rows[0].cells["c2"].count).toBe(0);

    // P02 has 0 Coping, 1 Exhaustion
    expect(matrix.rows[1].cells["c1"].count).toBe(0);
    expect(matrix.rows[1].cells["c2"].count).toBe(1);
    expect(matrix.rows[1].cells["c2"].snippets[0].quote).toBe("By Friday I collapse.");
  });

  it("generates Excel-compatible CSV with UTF-8 BOM", () => {
    const matrix = buildFrameworkMatrix(codes, interviews, codedSegments);
    const csv = generateFrameworkMatrixCsv(matrix);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("Participant ID,Coping Strategy,Exhaustion");
    expect(csv).toContain("P01");
    expect(csv).toContain("P02");
    expect(csv).toContain("(Rehearsal)");
  });
});
