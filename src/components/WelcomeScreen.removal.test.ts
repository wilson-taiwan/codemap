import { describe, expect, it } from "vitest";

export interface RemovalTarget {
  title: string;
  path?: string;
  projectId?: string;
  isBound: boolean;
  isAdmin: boolean;
  isRemoteOnly?: boolean;
}

export type RemovalMode = "detach" | "leave" | "delete_group" | "delete_solo";

export function determineAvailableRemovalModes(target: RemovalTarget): RemovalMode[] {
  if (!target.isBound) {
    return ["delete_solo"];
  }
  if (target.isRemoteOnly) {
    return ["leave"];
  }
  const modes: RemovalMode[] = ["detach", "leave"];
  if (target.isAdmin) {
    modes.push("delete_group");
  }
  return modes;
}

export function getDefaultRemovalMode(target: RemovalTarget): RemovalMode {
  if (!target.isBound) return "delete_solo";
  if (target.isRemoteOnly) return "leave";
  return "detach";
}

describe("study-removal state machine", () => {
  it("determines available modes for solo unbound study", () => {
    const solo: RemovalTarget = {
      title: "Solo Study",
      path: "/Users/test/Solo",
      isBound: false,
      isAdmin: false,
    };
    expect(determineAvailableRemovalModes(solo)).toEqual(["delete_solo"]);
    expect(getDefaultRemovalMode(solo)).toBe("delete_solo");
  });

  it("determines available modes for bound coder study (non-admin)", () => {
    const boundCoder: RemovalTarget = {
      title: "Shared Project",
      path: "/Users/test/Shared",
      projectId: "proj-123",
      isBound: true,
      isAdmin: false,
    };
    expect(determineAvailableRemovalModes(boundCoder)).toEqual(["detach", "leave"]);
    expect(getDefaultRemovalMode(boundCoder)).toBe("detach");
  });

  it("determines available modes for bound admin study", () => {
    const boundAdmin: RemovalTarget = {
      title: "Shared Project",
      path: "/Users/test/Shared",
      projectId: "proj-123",
      isBound: true,
      isAdmin: true,
    };
    expect(determineAvailableRemovalModes(boundAdmin)).toEqual(["detach", "leave", "delete_group"]);
    expect(getDefaultRemovalMode(boundAdmin)).toBe("detach");
  });

  it("determines available modes for remote-only study (no local folder)", () => {
    const remoteOnly: RemovalTarget = {
      title: "Remote Group",
      projectId: "proj-456",
      isBound: true,
      isAdmin: false,
      isRemoteOnly: true,
    };
    expect(determineAvailableRemovalModes(remoteOnly)).toEqual(["leave"]);
    expect(getDefaultRemovalMode(remoteOnly)).toBe("leave");
  });
});
