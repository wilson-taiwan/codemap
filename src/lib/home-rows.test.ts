import { describe, it, expect } from "vitest";
import { deriveHomeRows, formatMembersPhrase, normalizeStudyTitle } from "./home-rows";
import type { MembershipSummary, RecentProject } from "./types";

describe("deriveHomeRows", () => {
  it("splits rows into individual and shared sections", () => {
    const recents: RecentProject[] = [
      {
        path: "/path/to/standalone",
        title: "Standalone Study",
        last_opened_at: "2026-08-21T10:00:00Z",
      },
      {
        path: "/path/to/bound",
        title: "Bound Study Local",
        last_opened_at: "2026-08-21T09:00:00Z",
        group_id: "group-1",
        group_title: "Bound Study Remote Title",
        coder_name: "Ada",
      },
    ];

    const liveMemberships: MembershipSummary[] = [
      {
        projectId: "group-1",
        title: "Bound Study Remote Title",
        coderName: "Ada",
        members: ["Ada", "Hiroko"],
        role: "admin",
      },
      {
        projectId: "group-2",
        title: "Unbound Remote Study",
        coderName: "Ada",
        members: ["Ada", "Sam"],
        role: "coder",
      },
    ];

    const sections = deriveHomeRows({
      recents,
      cachedMemberships: [],
      liveMemberships,
      signedIn: true,
    });

    expect(sections.individual).toHaveLength(1);
    expect(sections.shared).toHaveLength(2);

    expect(sections.individual[0]).toEqual({
      kind: "standalone-project",
      path: "/path/to/standalone",
      title: "Standalone Study",
      lastOpenedAt: "2026-08-21T10:00:00Z",
      readiness: undefined,
      formerGroupId: undefined,
      formerGroupTitle: undefined,
    });

    expect(sections.shared[0]).toEqual({
      kind: "bound-group",
      projectId: "group-1",
      title: "Bound Study Remote Title",
      path: "/path/to/bound",
      coderName: "Ada",
      members: ["Ada", "Hiroko"],
      role: "admin",
      lastOpenedAt: "2026-08-21T09:00:00Z",
      isOffline: false,
      readiness: undefined,
    });

    expect(sections.shared[1]).toEqual({
      kind: "remote-group-unbound",
      projectId: "group-2",
      title: "Unbound Remote Study",
      coderName: "Ada",
      members: ["Ada", "Sam"],
      role: "coder",
    });

    // Verify mutual exclusivity: no path or id appears in both sections
    const individualPaths = new Set(sections.individual.map((r) => ("path" in r ? r.path : "")));
    for (const s of sections.shared) {
      if ("path" in s) {
        expect(individualPaths.has(s.path)).toBe(false);
      }
    }
  });

  it("uses cached memberships when live memberships are null (offline)", () => {
    const recents: RecentProject[] = [
      {
        path: "/path/to/bound",
        title: "Bound Study",
        last_opened_at: "2026-08-21T09:00:00Z",
        group_id: "group-1",
      },
    ];

    const cachedMemberships: MembershipSummary[] = [
      {
        projectId: "group-1",
        title: "Cached Bound Title",
        coderName: "Ada",
        members: ["Ada", "Alice"],
        role: "admin",
      },
      {
        projectId: "group-unbound",
        title: "Cached Unbound Title",
        coderName: "Ada",
        members: ["Ada"],
        role: "coder",
      },
    ];

    const sections = deriveHomeRows({
      recents,
      cachedMemberships,
      liveMemberships: null,
      signedIn: true,
    });

    expect(sections.individual).toHaveLength(0);
    expect(sections.shared).toHaveLength(2);
    expect(sections.shared[0].kind).toBe("bound-group");
    if (sections.shared[0].kind === "bound-group") {
      expect(sections.shared[0].isOffline).toBe(true);
      expect(sections.shared[0].title).toBe("Cached Bound Title");
      expect(sections.shared[0].role).toBe("admin");
    }
    expect(sections.shared[1].kind).toBe("remote-group-unbound");
  });

  it("handles offline launch with no cache gracefully", () => {
    const recents: RecentProject[] = [
      {
        path: "/path/to/bound",
        title: "Local Title",
        last_opened_at: "2026-08-21T09:00:00Z",
        group_id: "group-1",
        group_title: "Cached Group Title",
        coder_name: "Ada L.",
      },
    ];

    const sections = deriveHomeRows({
      recents,
      cachedMemberships: [],
      liveMemberships: null,
      signedIn: false,
    });

    expect(sections.individual).toHaveLength(0);
    expect(sections.shared).toHaveLength(1);
    expect(sections.shared[0]).toEqual({
      kind: "bound-group",
      projectId: "group-1",
      title: "Cached Group Title",
      path: "/path/to/bound",
      coderName: "Ada L.",
      members: ["Ada L."],
      role: "coder",
      lastOpenedAt: "2026-08-21T09:00:00Z",
      isOffline: true,
      readiness: undefined,
    });
  });

  it("suppresses ghost remote-group-unbound when former_group_id matches (Task 6)", () => {
    const recents: RecentProject[] = [
      {
        path: "/path/to/detached",
        title: "Detached Study",
        last_opened_at: "2026-08-21T10:00:00Z",
        former_group_id: "group-detached",
        former_group_title: "Shared Study Former Title",
      },
    ];

    const memberships: MembershipSummary[] = [
      {
        projectId: "group-detached",
        title: "Shared Study Former Title",
        coderName: "Wilson",
        members: ["Wilson", "Hiroko"],
        role: "admin",
      },
    ];

    const sections = deriveHomeRows({
      recents,
      cachedMemberships: [],
      liveMemberships: memberships,
      signedIn: true,
    });

    // Exactly one row, in Individual, with formerGroupId
    expect(sections.individual).toHaveLength(1);
    expect(sections.shared).toHaveLength(0);
    expect(sections.individual[0]).toEqual({
      kind: "standalone-project",
      path: "/path/to/detached",
      title: "Detached Study",
      lastOpenedAt: "2026-08-21T10:00:00Z",
      readiness: undefined,
      formerGroupId: "group-detached",
      formerGroupTitle: "Shared Study Former Title",
    });
  });

  it("detects same-titled groups and attaches duplicateOf metadata (Task 7)", () => {
    // Two groups with title "Health Outcomes Study"
    const recents: RecentProject[] = [
      {
        path: "/path/to/health-study",
        title: "Health Outcomes Study",
        last_opened_at: "2026-09-02T10:00:00Z",
        group_id: "bb79de68",
        coder_name: "Alex (Mac)",
      },
    ];

    const liveMemberships: MembershipSummary[] = [
      {
        projectId: "8b4d2515",
        title: "Health Outcomes Study",
        coderName: "Alex",
        members: ["Alex", "Alex (Windows)"],
        role: "admin",
      },
      {
        projectId: "bb79de68",
        title: "Health Outcomes Study",
        coderName: "Alex (Mac)",
        members: ["Alex (Mac)"],
        role: "admin",
      },
    ];

    const sections = deriveHomeRows({
      recents,
      cachedMemberships: [],
      liveMemberships,
      signedIn: true,
    });

    expect(sections.shared).toHaveLength(2);
    const row1 = sections.shared.find((r) => r.projectId === "bb79de68");
    const row2 = sections.shared.find((r) => r.projectId === "8b4d2515");

    expect(row1?.duplicateOf).toEqual(["8b4d2515"]);
    expect(row2?.duplicateOf).toEqual(["bb79de68"]);
  });

  it("sorts by readiness priority then recency (Task 12)", () => {
    const recents: RecentProject[] = [
      {
        path: "/path/to/ready-recent",
        title: "Ready Recent",
        last_opened_at: "2026-09-02T12:00:00Z",
        readiness: { kind: "ready" },
      },
      {
        path: "/path/to/missing-older",
        title: "Missing Older",
        last_opened_at: "2026-09-01T12:00:00Z",
        readiness: { kind: "missing-transcripts", missingCount: 2 },
      },
      {
        path: "/path/to/behind",
        title: "Behind",
        last_opened_at: "2026-09-02T11:00:00Z",
        readiness: { kind: "behind", behindCount: 5 },
      },
    ];

    const sections = deriveHomeRows({
      recents,
      cachedMemberships: [],
      liveMemberships: [],
      signedIn: true,
    });

    // readiness priorities: missing-transcripts (1), behind (3), ready (5)
    expect(sections.individual.map((r) => r.title)).toEqual([
      "Missing Older",
      "Behind",
      "Ready Recent",
    ]);
  });
});

describe("normalizeStudyTitle", () => {
  it("trims, case-folds, and collapses internal whitespace", () => {
    expect(normalizeStudyTitle("  Health   Outcomes   Study  ")).toBe(
      "health outcomes study",
    );
  });
});

describe("formatMembersPhrase", () => {
  it("formats empty when only you are in the group", () => {
    expect(formatMembersPhrase(["Ada"], "Ada")).toBe("");
  });

  it("formats 1 other person", () => {
    expect(formatMembersPhrase(["Ada", "Hiroko"], "Ada")).toBe("with Hiroko");
  });

  it("formats 2 other people", () => {
    expect(formatMembersPhrase(["Ada", "Hiroko", "Sam"], "Ada")).toBe("with Hiroko and Sam");
  });

  it("formats 3 other people", () => {
    expect(formatMembersPhrase(["Ada", "Hiroko", "Sam", "Alice"], "Ada")).toBe("with Hiroko, Sam and Alice");
  });

  it("formats >3 other people with count", () => {
    expect(formatMembersPhrase(["Ada", "Hiroko", "Sam", "Alice", "Bob"], "Ada")).toBe("with Hiroko, Sam and 2 others");
  });
});
