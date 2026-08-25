import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: {
    getUpdateStatus: vi.fn(),
    updateCheck: vi.fn(),
    updateDownload: vi.fn(),
    updateCancelDownload: vi.fn(),
    updateInstall: vi.fn(),
  },
}));

import { api } from "../lib/api";
import { useUpdateStore } from "./update-store";

const availableStatus = {
  phase: "available" as const,
  currentVersion: "0.26.1",
  targetVersion: "0.27.0",
  downloadedBytes: 0,
  totalBytes: null,
  lastCheckedAt: "2026-08-23T00:00:00Z",
  syncPreflightOutcome: null,
  failure: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useUpdateStore.setState({
    status: availableStatus,
    update: { version: "0.27.0" },
    checking: false,
    downloading: false,
    installing: false,
    listenerStarted: false,
  });
  vi.mocked(api.getUpdateStatus).mockResolvedValue(availableStatus);
});

describe("v0.27 updater ordering regression", () => {
  it("does not invoke install preparation when verified download fails", async () => {
    vi.mocked(api.updateDownload).mockRejectedValue(new Error("synthetic download failure"));

    await useUpdateStore.getState().downloadUpdate();

    expect(api.updateDownload).toHaveBeenCalledTimes(1);
    expect(api.updateInstall).not.toHaveBeenCalled();
    expect(api.getUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it("does not let React relaunch after native install begins", async () => {
    vi.mocked(api.updateInstall).mockResolvedValue({
      ...availableStatus,
      phase: "preparing",
    });

    await useUpdateStore.getState().installUpdate();

    expect(api.updateInstall).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().installing).toBe(true);
  });

  it("moves the primary action through check, download, then native install", async () => {
    vi.mocked(api.updateDownload).mockResolvedValue({
      ...availableStatus,
      phase: "readyToInstall",
    });
    await useUpdateStore.getState().runPrimaryAction();
    expect(api.updateDownload).toHaveBeenCalledTimes(1);

    await useUpdateStore.getState().runPrimaryAction();
    expect(api.updateInstall).toHaveBeenCalledTimes(1);
  });
});
