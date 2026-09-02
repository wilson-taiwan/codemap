import { describe, expect, it, vi } from "vitest";
import { formatJoinError, resolveInterviewForImport } from "./JoinStudyModal";
import { api } from "../lib/api";
import type { Interview } from "../lib/types";

describe("resolveInterviewForImport", () => {
  it("resolves the existing interview from api.listInterviews and never calls createInterview when found", async () => {
    const existing: Interview = {
      id: "inv-1",
      participant_label: "interview1-transcript",
      interview_date: null,
      modality: null,
      diagnosis_notes: null,
      interviewers: [],
      hub_memo: null,
      audio_path: null,
      segment_count: 5,
      remote_segment_count: 5,
    };

    vi.spyOn(api, "listInterviews").mockResolvedValue([existing]);
    const createMock = vi.fn();

    const resolved = await resolveInterviewForImport("interview1-transcript", createMock);

    expect(resolved).toEqual(existing);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("calls createInterview fallback when interview is not present in SQLite", async () => {
    vi.spyOn(api, "listInterviews").mockResolvedValue([]);
    const created: Interview = {
      id: "inv-2",
      participant_label: "P08",
      interview_date: null,
      modality: null,
      diagnosis_notes: null,
      interviewers: [],
      hub_memo: null,
      audio_path: null,
      segment_count: 0,
      remote_segment_count: null,
    };
    const createMock = vi.fn().mockResolvedValue(created);

    const resolved = await resolveInterviewForImport("P08", createMock);

    expect(resolved).toEqual(created);
    expect(createMock).toHaveBeenCalledWith("P08");
  });
});

describe("formatJoinError", () => {
  it("parses CODEMAP_FILE_ERROR sentinel into friendly message without raw sentinel string", () => {
    const rawError =
      'CODEMAP_FILE_ERROR|{"category":"permission_denied","message":"Fleuron cannot open this folder because permission was denied.","detail":"os error 13"}';
    const formatted = formatJoinError(rawError);
    expect(formatted.message).toBe(
      "Fleuron cannot open this folder because permission was denied.",
    );
    expect(formatted.message).not.toContain("CODEMAP_FILE_ERROR");
    expect(formatted.category).toBe("permission_denied");
    expect(formatted.detail).toBe("os error 13");
  });

  it("handles plain string error as other category", () => {
    const formatted = formatJoinError("Network request failed");
    expect(formatted.message).toBe("Network request failed");
    expect(formatted.category).toBe("other");
  });
});
