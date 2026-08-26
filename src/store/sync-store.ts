import { create } from "zustand";
import { api } from "../lib/api";
import type { GroupInfo, SyncOutcome, SyncStatus } from "../lib/types";
import { useProjectStore } from "./project-store";

let activeUiSyncRequests = 0;

/**
 * Sync state for the toolbar chip and the group sheet.
 *
 * Coding never waits on any of this. Every write still lands in local SQLite
 * first and syncing is a background reconciliation, so a failed run leaves the
 * app fully usable and simply retries later. That is why every error here is
 * held as a string for display rather than thrown: there is no call site for
 * which a sync failure should interrupt what the coder is doing.
 */

interface SyncStore {
  status: SyncStatus | null;
  syncing: boolean;
  error: string | null;
  /** The most recent run, for the "pulled 3 passages" line. */
  lastOutcome: SyncOutcome | null;
  showSyncSheet: boolean;
  /** True while a silent protocol-2 activation attempt is in flight. */
  autoActivatingV2: boolean;
  /**
   * The open project's group — key, roster, activity. Null when the project
   * has no group or the roster has not been fetched yet.
   */
  group: GroupInfo | null;
  /**
   * Whether the last roster fetch succeeded. The sheet needs this to tell
   * "this project has no group yet" apart from "the group did not load" —
   * showing the create form on a fetch failure would offer to mint a group
   * that already exists.
   */
  groupLoaded: boolean;

  refreshStatus: () => Promise<void>;
  restoreSession: () => Promise<void>;
  /** Fetch the group's key and roster. Silent on failure — the sheet shows
   *  what it last knew, and the status pills already say when sync is down. */
  refreshGroup: () => Promise<void>;
  /**
   * Turn the open project into a group and take `coderName` as your name in
   * it. Resolves false with `error` set when any step fails.
   */
  createGroup: (title: string, coderName: string) => Promise<boolean>;
  /** Mint a fresh group key, retiring the old one. */
  resetGroupKey: () => Promise<void>;
  /**
   * Change the name you file under. The server rewrites your coded rows; the
   * local coder list and identity follow. Resolves false with `error` set on
   * failure — most commonly a name somebody else in the group already holds.
   */
  renameSelf: (coderName: string) => Promise<boolean>;
  setMemberRole: (userId: string, role: string) => Promise<boolean>;
  removeMember: (userId: string) => Promise<boolean>;
  deleteGroup: (confirmTitle: string) => Promise<boolean>;
  signIn: (email: string, password: string) => Promise<boolean>;
  /**
   * Create an account. `"confirm"` means the server wants an email click
   * before the session exists; `"ok"` means signed in; `"error"` means
   * `error` is set.
   */
  signUp: (
    email: string,
    password: string,
  ) => Promise<"ok" | "confirm" | "error">;
  /**
   * Email a reset code. Resolves false with `error` set on a real failure
   * (rate limit, no network). A quiet success does not mean the inbox exists.
   */
  requestPasswordReset: (email: string) => Promise<boolean>;
  /**
   * Verify the email's code and set a new password. Signs in on
   * success. Resolves false with `error` set on failure.
   */
  completePasswordReset: (input: {
    email: string;
    password: string;
    token?: string | null;
    tokenHash?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
  }) => Promise<boolean>;
  signOut: () => Promise<void>;
  /**
   * Join a group by key and bind the *open* project folder to it. Refuses if
   * that folder is already in a different group.
   */
  joinAndBindOpenProject: (key: string, coderName: string) => Promise<boolean>;
  syncNow: (opts?: { silent?: boolean }) => Promise<void>;
  /**
   * Silently upgrade the open protocol-1 study to Sync Protocol 2 when the
   * caller is its admin and every member is ready, leaving the study working
   * on Protocol 1 otherwise. Never surfaces an error and never interrupts
   * work: a study that is not ready simply retries on a later trigger.
   */
  maybeAutoActivateV2: () => Promise<void>;
  openSyncSheet: () => void;
  closeSyncSheet: () => void;
  clearError: () => void;
}

export const useSyncStore = create<SyncStore>((set, get) => ({
  status: null,
  syncing: false,
  error: null,
  lastOutcome: null,
  showSyncSheet: false,
  autoActivatingV2: false,
  group: null,
  groupLoaded: false,

  refreshGroup: async () => {
    try {
      const group = await api.syncGroupInfo();
      set({ group, groupLoaded: true });
      const project = useProjectStore.getState().project;
      const status = get().status;
      if (status?.inGroup && project && group.title && group.title !== project.title) {
        useProjectStore.getState().adoptProjectTitle(group.title);
      }
    } catch {
      // Offline, signed out, or the project has no group yet. The sheet
      // distinguishes those from `status`; a stale roster is better than a
      // flashing error.
      set({ groupLoaded: false });
    }
  },

  createGroup: async (title, coderName) => {
    set({ error: null });
    try {
      const created = await api.syncCreateProject(title);
      await api.syncJoinProject(created.projectId);
      // The membership starts under the creator's email address — the server
      // trigger has nothing better — so the name chosen here is what settles
      // it. The same call swaps the name into the local coder list.
      await api.syncSetMyCoderName(coderName);
      useProjectStore.getState().adoptCoderName(coderName);
      await get().refreshStatus();
      await get().refreshGroup();
      // Creating re-offers everything local, so run immediately rather than
      // leaving the coder looking at a group that says nothing has synced.
      await get().syncNow();
      await get().maybeAutoActivateV2();
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  resetGroupKey: async () => {
    set({ error: null });
    try {
      await api.syncResetGroupKey();
      await get().refreshGroup();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  renameSelf: async (coderName) => {
    set({ error: null });
    try {
      const renamed = await api.syncSetMyCoderName(coderName);
      useProjectStore.getState().adoptCoderName(renamed.coderName);
      await get().refreshGroup();
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  setMemberRole: async (userId, role) => {
    set({ error: null });
    try {
      await api.syncSetMemberRole(userId, role);
      await get().refreshGroup();
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  removeMember: async (userId) => {
    set({ error: null });
    try {
      await api.syncRemoveMember(userId);
      await get().refreshGroup();
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  deleteGroup: async (confirmTitle) => {
    set({ error: null });
    try {
      await api.syncDeleteGroup(confirmTitle);
      await get().refreshStatus();
      await get().refreshGroup();
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  /**
   * Sign in from the keychain, if a previous launch left something there.
   *
   * Silent on every failure. No server configured, no stored token and no
   * network are all ordinary states at startup, and an error toast before the
   * coder has done anything would be the first thing they see.
   */
  restoreSession: async () => {
    try {
      await api.syncRestoreSession();
    } catch {
      // Sign in by hand instead.
    }
    await get().refreshStatus();
  },

  refreshStatus: async () => {
    try {
      set({ status: await api.syncStatus() });
    } catch {
      // No project open, or preferences unreadable. The chip hides itself.
      set({ status: null });
    }
  },

  signIn: async (email, password) => {
    set({ error: null });
    try {
      await api.syncSignIn(email, password);
      await get().refreshStatus();
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  signUp: async (email, password) => {
    set({ error: null });
    try {
      const usable = await api.syncSignUp(email, password);
      if (!usable) return "confirm";
      await get().refreshStatus();
      return "ok";
    } catch (e) {
      set({ error: String(e) });
      return "error";
    }
  },

  requestPasswordReset: async (email) => {
    set({ error: null });
    try {
      await api.syncRequestPasswordReset(email);
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  completePasswordReset: async (input) => {
    set({ error: null });
    try {
      await api.syncCompletePasswordReset(input);
      await get().refreshStatus();
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  signOut: async () => {
    await api.syncSignOut();
    set({ group: null, groupLoaded: false });
    await get().refreshStatus();
  },

  joinAndBindOpenProject: async (key, coderName) => {
    set({ error: null });
    try {
      const joined = await api.syncJoinGroup(key, coderName);
      await api.syncJoinProject(joined.projectId);
      useProjectStore.getState().adoptCoderName(joined.coderName);
      await get().refreshStatus();
      await get().refreshGroup();
      await get().syncNow();
      return true;
    } catch (e) {
      set({ error: String(e) });
      return false;
    }
  },

  syncNow: async (opts) => {
    activeUiSyncRequests += 1;
    set({ syncing: true, error: opts?.silent ? get().error : null });
    try {
      const outcome = await api.syncNow();
      set({ lastOutcome: outcome, error: null });
      const projectStore = useProjectStore.getState();
      if (projectStore.project) {
        const snapshot = await api.getLiveWorkspaceSnapshot(
          projectStore.activeInterviewId,
        );
        useProjectStore.getState().reconcileLiveWorkspace(snapshot);
      }
      void get().refreshGroup();
    } catch (e) {
      if (!opts?.silent) set({ error: String(e) });
    } finally {
      activeUiSyncRequests = Math.max(0, activeUiSyncRequests - 1);
      if (activeUiSyncRequests === 0) set({ syncing: false });
      await get().refreshStatus();
    }
  },

  maybeAutoActivateV2: async () => {
    const s = get();
    const status = s.status;
    // Only a study admin can activate; the server re-checks admin + all-ready
    // itself, so a stale view here just becomes one more silent retry.
    if (!status?.isGroupAdmin) return;
    if (status.protocol !== 1) return; // already P2 (or no v2 protocol)
    if ((status.serverSchemaVersion ?? 0) < 10) return;
    if (s.autoActivatingV2) return; // in-flight guard: no duplicate RPCs
    set({ autoActivatingV2: true });
    try {
      const readiness = await api.syncV2Readiness();
      const allReady =
        readiness.protocol === 1 &&
        readiness.members.length > 0 &&
        readiness.members.every((m) => m.ready);
      if (!allReady) return; // wait until every member has updated + synced
      await api.syncV2Activate(); // server re-checks admin + all-ready
      await get().syncNow({ silent: true }); // re-register → protocol 2 + salvage
      await get().refreshStatus();
      await get().refreshGroup();
    } catch {
      // Not-all-ready / transient / pre-v2 server: stay on P1, retry next
      // trigger. This must never replace the store's visible error.
    } finally {
      set({ autoActivatingV2: false });
    }
  },

  openSyncSheet: () => {
    set({ showSyncSheet: true, error: null });
    void get().refreshGroup();
  },
  closeSyncSheet: () => set({ showSyncSheet: false }),
  clearError: () => set({ error: null }),
}));
