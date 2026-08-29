import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./export-config";
import { generateHtmlReport } from "./report-html";
import type { Code, CodedSegment, Interview, ProjectInfo } from "./types";

describe("report-html", () => {
  const project: ProjectInfo = {
    path: "/test/path",
    title: "Sample Study <2026>",
    methodology: "reflexive-ta",
    coders: ["Ada Lovelace"],
    last_saved_by: "Ada Lovelace",
    last_saved_at: "2026-08-22T10:00:00Z",
  };

  const codes: Code[] = [
    {
      id: "c1",
      name: "Unwritten rules",
      definition: "Preparing social scripts.",
      inclusion_criteria: "Explicit scripting",
      exclusion_criteria: null,
      example: null,
      parent_id: null,
      color: "#8a6410",
      sort_order: 0,
      is_retired: false,
      usage_count: 1,
    },
    {
      id: "c2",
      name: "Retired code",
      definition: null,
      inclusion_criteria: null,
      exclusion_criteria: null,
      example: null,
      parent_id: null,
      color: "#999999",
      sort_order: 1,
      is_retired: true,
      usage_count: 0,
    },
  ];

  const interviews: Interview[] = [
    {
      id: "iv-1",
      participant_label: "P04",
      interview_date: "2026-03-11",
      modality: "zoom",
      diagnosis_notes: null,
      interviewers: ["Ada Lovelace"],
      hub_memo: "Key insight on rehearsal.",
      audio_path: null,
      segment_count: 1,
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
      memo: "Participant metaphor",
      char_start: null,
      char_end: null,
      quote_text: "I've been rehearsing that hello since the drive in.",
      block_id: null,
      timestamp_start: "00:02:00.000",
      participant_label: "P04",
    },
  ];

  it("generates self-contained HTML escaping dangerous characters", () => {
    const config = getDefaultConfig("reflexive-ta");
    const html = generateHtmlReport({
      project,
      config,
      codes,
      interviews,
      codedSegments,
      exportedBy: "Ada Lovelace",
      exportedAt: "2026-08-22T12:00:00Z",
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Sample Study &lt;2026&gt;");
    expect(html).toContain("Reflexive thematic analysis");
    expect(html).toContain("Unwritten rules");
    expect(html).toContain("Preparing social scripts.");
    expect(html).toContain("I&#39;ve been rehearsing that hello since the drive in.");
    expect(html).toContain("@media print");
    expect(html).toContain("Retired Codes");
    // Counts omitted in reflexive-ta by default
    expect(html).not.toContain("Coding Frequencies &amp; Corpus Breadth");
  });

  it("includes frequencies and framework matrix when configured", () => {
    const config = getDefaultConfig("framework-analysis");
    const html = generateHtmlReport({
      project,
      config,
      codes,
      interviews,
      codedSegments,
      exportedBy: "Ada Lovelace",
      exportedAt: "2026-08-22T12:00:00Z",
    });

    expect(html).toContain("Coding Frequencies &amp; Corpus Breadth");
    expect(html).toContain("Framework Analysis Matrix (Case × Code)");
  });

  it("discloses unresolved conflict count without including proposal content", () => {
    const html = generateHtmlReport({
      project,
      config: getDefaultConfig("reflexive-ta"),
      codes,
      interviews,
      codedSegments,
      exportedBy: "Ada Lovelace",
      exportedAt: "2026-08-22T12:00:00Z",
      unresolvedConflictCount: 2,
    });

    expect(html).toContain("2 unresolved sync conflicts");
    expect(html).toContain("current canonical study values");
    expect(html).not.toContain("proposal-content-sentinel");
  });
});
