import { describe, expect, it } from "vitest";
import { breadcrumbSegments } from "./Toolbar";

describe("breadcrumbSegments", () => {
  it("derives solo study segments with active participant and active coder", () => {
    const segments = breadcrumbSegments({
      studyTitle: "Sample Study",
      activeInterview: { participant_label: "P07", segment_count: 42 },
      activeCoder: "Ada",
      isShared: false,
    });

    expect(segments.study).toBe("Sample Study");
    expect(segments.participant.label).toBe("P07");
    expect(segments.participant.isLinked).toBe(true);
    expect(segments.coder.name).toBe("Ada");
    expect(segments.coder.isShared).toBe(false);
  });

  it("identifies unlinked participants when segment_count is 0", () => {
    const segments = breadcrumbSegments({
      studyTitle: "Interview Study",
      activeInterview: { participant_label: "P08", segment_count: 0 },
      activeCoder: "Ada",
      isShared: false,
    });

    expect(segments.participant.label).toBe("P08");
    expect(segments.participant.isLinked).toBe(false);
  });

  it("handles missing active interview gracefully", () => {
    const segments = breadcrumbSegments({
      studyTitle: "Interview Study",
      activeInterview: null,
      activeCoder: "Ada",
      isShared: false,
    });

    expect(segments.participant.label).toBe("No participant");
    expect(segments.participant.isLinked).toBe(true);
  });

  it("uses myRosterName in shared studies", () => {
    const segments = breadcrumbSegments({
      studyTitle: "Sample Study",
      activeInterview: { participant_label: "P07", segment_count: 10 },
      activeCoder: "Fallback",
      isShared: true,
      myRosterName: "Ada (Admin)",
    });

    expect(segments.coder.name).toBe("Ada (Admin)");
    expect(segments.coder.isShared).toBe(true);
  });

  it("formats presence tooltips correctly for active and idle coders", () => {
    const isRecentlyActive = (updatedAt: string, now: number) => {
      const ageMs = now - new Date(updatedAt).getTime();
      return !Number.isNaN(ageMs) && ageMs < 60000;
    };

    const formatPresenceTooltip = (
      user: { coderName: string; participantLabel: string; updatedAt: string },
      now: number,
    ) => {
      const active = isRecentlyActive(user.updatedAt, now);
      if (user.participantLabel && active) {
        return `${user.coderName} — coding ${user.participantLabel}`;
      }
      return `${user.coderName} — idle`;
    };

    const now = 1000000000000;
    const activeTime = new Date(now - 10000).toISOString();
    const idleTime = new Date(now - 120000).toISOString();

    expect(
      formatPresenceTooltip(
        { coderName: "Sam", participantLabel: "P07", updatedAt: activeTime },
        now,
      ),
    ).toBe("Sam — coding P07");

    expect(
      formatPresenceTooltip(
        { coderName: "Sam", participantLabel: "P07", updatedAt: idleTime },
        now,
      ),
    ).toBe("Sam — idle");

    expect(
      formatPresenceTooltip(
        { coderName: "Sam", participantLabel: "", updatedAt: activeTime },
        now,
      ),
    ).toBe("Sam — idle");
  });
});
