import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  api: {
    syncNow: vi.fn(),
    syncStatus: vi.fn(),
    syncGroupInfo: vi.fn(),
  },
}));

vi.mock("./project-store", () => ({
  useProjectStore: {
    getState: () => ({ project: null }),
  },
}));

import { api } from "../lib/api";
import { useSyncStore } from "./sync-store";

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

beforeEach(() => {
  vi.clearAllMocks();
  useSyncStore.setState({
    status: null,
    syncing: false,
    error: null,
    lastOutcome: null,
    showSyncSheet: false,
    group: null,
    groupLoaded: false,
  });
  vi.mocked(api.syncStatus).mockResolvedValue(null as never);
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
