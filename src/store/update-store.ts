import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api } from "../lib/api";
import type { UpdateCoordinatorStatus } from "../lib/types";

export interface AvailableUpdate {
  version: string;
}

interface UpdateStore {
  status: UpdateCoordinatorStatus | null;
  update: AvailableUpdate | null;
  checking: boolean;
  downloading: boolean;
  installing: boolean;
  listenerStarted: boolean;
  /**
   * Origin of the most recent check. A background (startup/interval) check
   * that fails stays silent — no banner, no dot; only a check the user asked
   * for shows an actionable failure.
   */
  lastCheckInteractive: boolean;
  manualCheckFailed: boolean;
  checkForUpdate: (interactive?: boolean) => Promise<void>;
  downloadUpdate: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  installUpdate: () => Promise<void>;
  runPrimaryAction: () => Promise<void>;
  refreshUpdateStatus: () => Promise<void>;
  startUpdateListener: () => Promise<() => void>;
}

function stateFromStatus(status: UpdateCoordinatorStatus) {
  return {
    status,
    update: status.targetVersion ? { version: status.targetVersion } : null,
    checking: status.phase === "checking",
    downloading: status.phase === "downloading",
    installing: status.phase === "preparing" || status.phase === "installing",
  };
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: null,
  update: null,
  checking: false,
  downloading: false,
  installing: false,
  listenerStarted: false,
  lastCheckInteractive: true,
  manualCheckFailed: false,

  checkForUpdate: async (interactive = true) => {
    if (import.meta.env.DEV || get().checking || get().downloading || get().installing) return;
    set({ lastCheckInteractive: interactive, manualCheckFailed: false });
    try {
      set(stateFromStatus(await api.updateCheck()));
    } catch {
      if (interactive) set({ manualCheckFailed: true });
      await get().refreshUpdateStatus();
    }
  },

  downloadUpdate: async () => {
    if (get().downloading || get().installing) return;
    try {
      set(stateFromStatus(await api.updateDownload()));
    } catch {
      await get().refreshUpdateStatus();
    }
  },

  cancelDownload: async () => {
    try {
      set(stateFromStatus(await api.updateCancelDownload()));
    } catch {
      await get().refreshUpdateStatus();
    }
  },

  installUpdate: async () => {
    if (get().installing) return;
    try {
      set(stateFromStatus(await api.updateInstall()));
    } catch {
      await get().refreshUpdateStatus();
    }
  },

  runPrimaryAction: async () => {
    const status = get().status;
    if (!status || status.phase === "idle" || (status.phase === "failed" && !status.targetVersion)) {
      await get().checkForUpdate();
      return;
    }
    if (status.phase === "available") {
      await get().downloadUpdate();
      return;
    }
    if (status.phase === "downloading") {
      await get().cancelDownload();
      return;
    }
    if (status.phase === "readyToInstall" || status.phase === "failed") {
      await get().installUpdate();
    }
  },

  refreshUpdateStatus: async () => {
    try {
      set(stateFromStatus(await api.getUpdateStatus()));
    } catch {
      // An unsupported development build can have no updater backend.
    }
  },

  startUpdateListener: async () => {
    if (get().listenerStarted) return () => {};
    set({ listenerStarted: true });
    const unlisten = await listen<UpdateCoordinatorStatus>("update://state", (event) => {
      set(stateFromStatus(event.payload));
    });
    return () => {
      unlisten();
      set({ listenerStarted: false });
    };
  },
}));
