import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  api: {
    syncNow: vi.fn(),
    syncStatus: vi.fn(),
    syncGroupInfo: vi.fn(),
    syncV2Readiness: vi.fn(),
    syncV2Activate: vi.fn(),
    syncCreateProject: vi.fn(),
    syncJoinProject: vi.fn(),
    syncSetMyCoderName: vi.fn(),
  },
}));

vi.mock("./project-store", () => ({
  useProjectStore: {
    getState: () => ({
      project: null,
      adoptCoderName: () => {},
      reconcileLiveWorkspace: () => {},
    }),
  },
}));

import { api } from "../lib/api";
import { useSyncStore } from "./sync-store";
import type { SyncStatus, SyncV2Readiness } from "../lib/types";

const outcome = {
  pushedCoded: 0,
  pushedCodes: 0,
  pulledCoded: 0,
  pulledCodes: 0,
  pulledInterviews: 0,
  missingTranscripts: [],
  newCodeNames: [],
  syncedAt: "2026-08-23T00:00:00.000Z",
  codedReceipt: { applied: 0, superseded: 0, deferred: 0 },
  codesReceipt: { applied: 0, superseded: 0, deferred: 0 },
  interviewsReceipt: { applied: 0, superseded: 0, deferred: 0 },
  truncated: false,
};

const activation = {
  protocol: 2 as const,
  generationSuffix: "00000002",
  head: 0,
  legacyActorRows: 0,
};

function readyReadiness(overrides?: Partial<SyncV2Readiness>): SyncV2Readiness {
  return {
    protocol: 1,
    generationSuffix: null,
    head: 0,
    members: [
      {
        userId: "me",
        coderName: "Ada",
        role: "admin",
        ready: true,
        readyAt: "2026-08-26T00:00:00.000Z",
        lastDeviceIdSuffix: "00000001",
      },
    ],
    ...overrides,
  };
}

function statusWith(overrides: Partial<SyncStatus>): SyncStatus {
  return {
    configured: true,
    signedIn: true,
    signedInEmail: "ada@example.com",
    serverPreset: true,
    projectId: "proj-1",
    inGroup: true,
    isGroupAdmin: true,
    lastSyncedAt: null,
    pendingChanges: 0,
    serverSchemaVersion: 10,
    requiredServerSchema: 10,
    protocol: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSyncStore.setState({
    status: null,
    syncing: false,
    error: null,
    lastOutcome: null,
    showSyncSheet: false,
    autoActivatingV2: false,
    group: null,
    groupLoaded: false,
  });
  vi.mocked(api.syncStatus).mockResolvedValue(null as never);
  vi.mocked(api.syncNow).mockResolvedValue(outcome);
  vi.mocked(api.syncV2Readiness).mockResolvedValue(readyReadiness());
  vi.mocked(api.syncV2Activate).mockResolvedValue(activation);
});

describe("v0.27 sync trigger regressions", () => {
  it("forwards every concurrent trigger to the native coordinator", async () => {
    let releaseFirst!: (value: typeof outcome) => void;
    const firstPass = new Promise<typeof outcome>((resolve) => {
      releaseFirst = resolve;
    });
    vi.mocked(api.syncNow)
      .mockReturnValueOnce(firstPass)
      .mockResolvedValue(outcome);

    const first = useSyncStore.getState().syncNow({ silent: true });
    await vi.waitFor(() => expect(api.syncNow).toHaveBeenCalledTimes(1));
    const remoteTrigger = useSyncStore.getState().syncNow({ silent: true });
    const localTrigger = useSyncStore.getState().syncNow({ silent: true });
    releaseFirst(outcome);

    await Promise.all([first, remoteTrigger, localTrigger]);

    expect(api.syncNow).toHaveBeenCalledTimes(3);
  });
});

describe("silent protocol-2 auto-activation", () => {
  it("activates once when admin + P1 + schema >= 10 + all ready, then refreshes", async () => {
    useSyncStore.setState({ status: statusWith({}) });

    await useSyncStore.getState().maybeAutoActivateV2();

    expect(api.syncV2Readiness).toHaveBeenCalledTimes(1);
    expect(api.syncV2Activate).toHaveBeenCalledTimes(1);
    expect(api.syncNow).toHaveBeenCalledTimes(1);
    expect(useSyncStore.getState().autoActivatingV2).toBe(false);
    // syncNow's finally refreshes status; the helper also refreshes group.
    expect(api.syncStatus).toHaveBeenCalled();
    expect(api.syncGroupInfo).toHaveBeenCalled();
  });

  it.each([
    ["non-admin", { isGroupAdmin: false } as Partial<SyncStatus>],
    ["already P2", { protocol: 2 } as Partial<SyncStatus>],
    ["old or unknown schema", { serverSchemaVersion: 9 } as Partial<SyncStatus>],
    ["no schema reported", { serverSchemaVersion: null } as Partial<SyncStatus>],
  ])("no-ops for %s status", async (_label, overrides) => {
    useSyncStore.setState({ status: statusWith(overrides) });

    await useSyncStore.getState().maybeAutoActivateV2();

    expect(api.syncV2Readiness).not.toHaveBeenCalled();
    expect(api.syncV2Activate).not.toHaveBeenCalled();
  });

  it.each([
    ["empty member list", readyReadiness({ members: [] })],
    [
      "one not-ready member",
      readyReadiness({
        members: [
          {
            userId: "other",
            coderName: "Luci",
            role: "coder",
            ready: false,
            readyAt: null,
            lastDeviceIdSuffix: null,
          },
        ],
      }),
    ],
    ["study no longer on P1", readyReadiness({ protocol: 2 })],
  ])("skips silently when readiness is not all-ready: %s", async (_label, readiness) => {
    useSyncStore.setState({ status: statusWith({}) });
    vi.mocked(api.syncV2Readiness).mockResolvedValue(readiness);

    await useSyncStore.getState().maybeAutoActivateV2();

    expect(api.syncV2Activate).not.toHaveBeenCalled();
    expect(useSyncStore.getState().autoActivatingV2).toBe(false);
  });

  it("coalesces overlapping calls into a single activation RPC", async () => {
    useSyncStore.setState({ status: statusWith({}) });
    let releaseActivate!: () => void;
    vi.mocked(api.syncV2Activate).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseActivate = () => resolve(activation);
        }),
    );

    const first = useSyncStore.getState().maybeAutoActivateV2();
    await vi.waitFor(() =>
      expect(useSyncStore.getState().autoActivatingV2).toBe(true),
    );
    const second = useSyncStore.getState().maybeAutoActivateV2();
    releaseActivate();
    await Promise.all([first, second]);

    expect(api.syncV2Activate).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight flag on readiness failure without touching store error, and a later retry succeeds", async () => {
    useSyncStore.setState({
      status: statusWith({}),
      error: "a pre-existing visible problem",
    });
    vi.mocked(api.syncV2Readiness).mockRejectedValueOnce(new Error("down"));

    await useSyncStore.getState().maybeAutoActivateV2();

    expect(api.syncV2Activate).not.toHaveBeenCalled();
    expect(useSyncStore.getState().autoActivatingV2).toBe(false);
    expect(useSyncStore.getState().error).toBe("a pre-existing visible problem");

    vi.mocked(api.syncV2Readiness).mockResolvedValueOnce(readyReadiness());
    await useSyncStore.getState().maybeAutoActivateV2();
    expect(api.syncV2Activate).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight flag when activation fails and a later retry can succeed", async () => {
    useSyncStore.setState({ status: statusWith({}) });
    vi.mocked(api.syncV2Activate).mockRejectedValueOnce(new Error("not all ready"));

    await useSyncStore.getState().maybeAutoActivateV2();

    expect(useSyncStore.getState().autoActivatingV2).toBe(false);
    expect(useSyncStore.getState().error).toBeNull();

    await useSyncStore.getState().maybeAutoActivateV2();
    expect(api.syncV2Activate).toHaveBeenCalledTimes(2);
  });

  it("createGroup returns true and activates only after its first sync", async () => {
    const created = { projectId: "proj-new", groupKey: "A1B2C3D4" };
    vi.mocked(api.syncCreateProject).mockResolvedValue(created);
    vi.mocked(api.syncJoinProject).mockResolvedValue(undefined as never);
    vi.mocked(api.syncSetMyCoderName).mockResolvedValue({
      coderName: "Ada",
      previousName: "a@fleuron.test.local",
    });
    vi.mocked(api.syncStatus).mockResolvedValue(
      statusWith({ projectId: "proj-new", protocol: 1 }),
    );
    vi.mocked(api.syncGroupInfo).mockResolvedValue({
      title: "New",
      groupKey: "A1B2C3D4",
      members: [
        {
          userId: "me",
          coderName: "Ada",
          role: "admin",
          joinedAt: "2026-08-26T00:00:00.000Z",
          lastActiveAt: "2026-08-26T00:00:00.000Z",
          codedCount: 0,
          isYou: true,
        },
      ],
    });
    const order: string[] = [];
    vi.mocked(api.syncNow).mockImplementation(async () => {
      order.push("sync");
      return outcome;
    });
    vi.mocked(api.syncV2Activate).mockImplementation(async () => {
      order.push("activate");
      return activation;
    });

    const okResult = await useSyncStore
      .getState()
      .createGroup("New Study", "Ada");

    expect(okResult, `store error: ${useSyncStore.getState().error}`).toBe(true);
    // store-level sync is silent; the post-activation refresh adds a second run
    expect(order).toEqual(["sync", "activate", "sync"]);
    expect(api.syncV2Activate).toHaveBeenCalledTimes(1);
  });
});
