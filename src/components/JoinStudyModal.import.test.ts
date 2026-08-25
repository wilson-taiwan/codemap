import { describe, expect, it, vi } from "vitest";
import { resolveInterviewForImport } from "./JoinStudyModal";
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
