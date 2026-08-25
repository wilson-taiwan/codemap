import { describe, it, expect } from "vitest";
import { deriveHomeRows, formatMembersPhrase } from "./home-rows";
import type { MembershipSummary, RecentProject } from "./types";

describe("deriveHomeRows", () => {
  it("orders bound groups first, then unbound remote groups, then standalone projects", () => {
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

    const rows = deriveHomeRows({
      recents,
      cachedMemberships: [],
      liveMemberships,
      signedIn: true,
    });

    expect(rows).toHaveLength(3);

    expect(rows[0]).toEqual({
      kind: "bound-group",
      projectId: "group-1",
      title: "Bound Study Remote Title",
      path: "/path/to/bound",
      coderName: "Ada",
      members: ["Ada", "Hiroko"],
      role: "admin",
      lastOpenedAt: "2026-08-21T09:00:00Z",
      isOffline: false,
    });

    expect(rows[1]).toEqual({
      kind: "remote-group-unbound",
      projectId: "group-2",
      title: "Unbound Remote Study",
      coderName: "Ada",
      members: ["Ada", "Sam"],
      role: "coder",
    });

    expect(rows[2]).toEqual({
      kind: "standalone-project",
      path: "/path/to/standalone",
      title: "Standalone Study",
      lastOpenedAt: "2026-08-21T10:00:00Z",
    });
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

    const rows = deriveHomeRows({
      recents,
      cachedMemberships,
      liveMemberships: null,
      signedIn: true,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].kind).toBe("bound-group");
    if (rows[0].kind === "bound-group") {
      expect(rows[0].isOffline).toBe(true);
      expect(rows[0].title).toBe("Cached Bound Title");
      expect(rows[0].role).toBe("admin");
    }
    expect(rows[1].kind).toBe("remote-group-unbound");
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

    const rows = deriveHomeRows({
      recents,
      cachedMemberships: [],
      liveMemberships: null,
      signedIn: false,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      kind: "bound-group",
      projectId: "group-1",
      title: "Cached Group Title",
      path: "/path/to/bound",
      coderName: "Ada L.",
      members: ["Ada L."],
      role: "coder",
      lastOpenedAt: "2026-08-21T09:00:00Z",
      isOffline: true,
    });
  });

  it("preserves cached admin role when live memberships omit bound group", () => {
    const recents: RecentProject[] = [
      {
        path: "/path/to/bound",
        title: "Bound Local Title",
        last_opened_at: "2026-08-21T09:00:00Z",
        group_id: "group-1",
        group_title: "Bound Remote Title",
        coder_name: "Ada",
      },
    ];

    const cachedMemberships: MembershipSummary[] = [
      {
        projectId: "group-1",
        title: "Bound Remote Title",
        coderName: "Ada",
        members: ["Ada", "Sam"],
        role: "admin",
      },
    ];

    // Live refresh returns memberships that do NOT contain group-1 (e.g. temporary gap or empty)
    const liveMemberships: MembershipSummary[] = [];

    const rows = deriveHomeRows({
      recents,
      cachedMemberships,
      liveMemberships,
      signedIn: true,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      kind: "bound-group",
      projectId: "group-1",
      title: "Bound Remote Title",
      path: "/path/to/bound",
      coderName: "Ada",
      members: ["Ada", "Sam"],
      role: "admin",
      lastOpenedAt: "2026-08-21T09:00:00Z",
      isOffline: true,
    });
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
