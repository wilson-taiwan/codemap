import { describe, expect, it } from "vitest";
import {
  matchFolderToRoster,
  type CandidateFile,
} from "./transcript-match";
import type { InterviewRosterEntry } from "./types";

const VTT_P07 = `WEBVTT

00:00:01.000 --> 00:00:04.000
P07: Hello world.

00:00:05.000 --> 00:00:08.000
Interviewer: Tell me more.
`;

const VTT_P08 = `WEBVTT

00:00:01.000 --> 00:00:04.000
P08: A completely different interview.
`;

describe("matchFolderToRoster", () => {
  it("matches by exact hash even when filename is completely unrelated", async () => {
    const files: CandidateFile[] = [
      {
        path: "/downloads/zoom_rec_2026_03_11.vtt",
        name: "zoom_rec_2026_03_11.vtt",
        rawText: VTT_P07,
      },
    ];

    const roster: InterviewRosterEntry[] = [
      {
        id: "id-p07",
        project_id: "proj1",
        study_label: "P07",
        segment_count: 2,
        content_hash: "mock-hash-p07",
        revision: 1,
        deleted: false,
        updated_at: null,
      },
    ];

    const mockHashFn = async (segments: Array<{ index: number; text: string }>) => {
      if (segments.some((s) => s.text.includes("Hello world"))) {
        return "mock-hash-p07";
      }
      return "other-hash";
    };

    const matches = await matchFolderToRoster(files, roster, {
      hashFn: mockHashFn,
    });

    const p07Match = matches.get("P07");
    expect(p07Match).toBeDefined();
    expect(p07Match?.confidence).toBe("exact-hash");
    expect(p07Match?.file?.name).toBe("zoom_rec_2026_03_11.vtt");
  });

  it("uses filename as fallback when remote hash is missing", async () => {
    const files: CandidateFile[] = [
      {
        path: "/transcripts/P07.vtt",
        name: "P07.vtt",
        rawText: VTT_P07,
      },
    ];

    const roster: InterviewRosterEntry[] = [
      {
        id: "id-p07",
        project_id: "proj1",
        study_label: "P07",
        segment_count: 2,
        content_hash: null, // remote hash missing
        revision: 1,
        deleted: false,
        updated_at: null,
      },
    ];

    const matches = await matchFolderToRoster(files, roster, {
      hashFn: async () => "local-hash",
    });

    const p07Match = matches.get("P07");
    expect(p07Match?.confidence).toBe("exact-hash");
    expect(p07Match?.file?.name).toBe("P07.vtt");
  });

  it("identifies near-miss filename matches with near-miss confidence", async () => {
    const files: CandidateFile[] = [
      {
        path: "/transcripts/P07b.vtt",
        name: "P07b.vtt",
        rawText: VTT_P07,
      },
    ];

    const roster: InterviewRosterEntry[] = [
      {
        id: "id-p07",
        project_id: "proj1",
        study_label: "P07",
        segment_count: 2,
        content_hash: null,
        revision: 1,
        deleted: false,
        updated_at: null,
      },
    ];

    const matches = await matchFolderToRoster(files, roster, {
      hashFn: async () => null,
    });

    const p07Match = matches.get("P07");
    expect(p07Match?.confidence).toBe("near-miss-filename");
    expect(p07Match?.file?.name).toBe("P07b.vtt");
    expect(p07Match?.why).toMatch(/near-miss/i);
  });

  it("correctly pairs multiple files with multi-interview roster", async () => {
    const files: CandidateFile[] = [
      {
        path: "/transcripts/file_a.vtt",
        name: "file_a.vtt",
        rawText: VTT_P07,
      },
      {
        path: "/transcripts/file_b.vtt",
        name: "file_b.vtt",
        rawText: VTT_P08,
      },
    ];

    const roster: InterviewRosterEntry[] = [
      {
        id: "id-p07",
        project_id: "proj1",
        study_label: "P07",
        segment_count: 2,
        content_hash: "hash-07",
        revision: 1,
        deleted: false,
        updated_at: null,
      },
      {
        id: "id-p08",
        project_id: "proj1",
        study_label: "P08",
        segment_count: 1,
        content_hash: "hash-08",
        revision: 1,
        deleted: false,
        updated_at: null,
      },
    ];

    const mockHashFn = async (segments: Array<{ index: number; text: string }>) => {
      if (segments.some((s) => s.text.includes("Hello world"))) return "hash-07";
      return "hash-08";
    };

    const matches = await matchFolderToRoster(files, roster, {
      hashFn: mockHashFn,
    });

    expect(matches.get("P07")?.file?.name).toBe("file_a.vtt");
    expect(matches.get("P08")?.file?.name).toBe("file_b.vtt");
  });

  it("does not silently assign ambiguous matches", async () => {
    const files: CandidateFile[] = [
      {
        path: "/transcripts/P07_v1.vtt",
        name: "P07_v1.vtt",
        rawText: VTT_P07,
      },
      {
        path: "/transcripts/P07_v2.vtt",
        name: "P07_v2.vtt",
        rawText: VTT_P07,
      },
    ];

    const roster: InterviewRosterEntry[] = [
      {
        id: "id-p07",
        project_id: "proj1",
        study_label: "P07",
        segment_count: 2,
        content_hash: null,
        revision: 1,
        deleted: false,
        updated_at: null,
      },
    ];

    const matches = await matchFolderToRoster(files, roster, {
      hashFn: async () => null,
    });

    // Since both files are near misses, ambiguous near miss is not assigned silently
    expect(matches.get("P07")?.confidence).toBe("unmatched");
  });
});
