import { useEffect } from "react";
import { api } from "../lib/api";
import { loadLastGuideSection, useGuideStore } from "../store/guide-store";
import { useAppStore } from "../store/app-store";
import { useSyncStore } from "../store/sync-store";
import { useProjectStore } from "../store/project-store";
import { hasModKey } from "../lib/platform";
import { useUpdateStore } from "../store/update-store";

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function useAppInit() {
  const loadPreferences = useAppStore((s) => s.loadPreferences);
  const restoreSession = useSyncStore((s) => s.restoreSession);
  const refreshGroup = useSyncStore((s) => s.refreshGroup);
  const initialized = useAppStore((s) => s.initialized);
  const reopenLast = useAppStore((s) => s.preferences.reopen_last_project);
  const setAutoOpenFailed = useAppStore.setState;
  const project = useProjectStore((s) => s.project);
  const openProject = useProjectStore((s) => s.openProject);
  const loading = useProjectStore((s) => s.loading);
  const checkForUpdate = useUpdateStore((s) => s.checkForUpdate);
  const refreshUpdateStatus = useUpdateStore((s) => s.refreshUpdateStatus);
  const startUpdateListener = useUpdateStore((s) => s.startUpdateListener);

  useEffect(() => {
    loadPreferences();
    // Sign in from the keychain before the workspace mounts, so background
    // sync is already running by the time the coder starts rather than waiting
    // for them to notice a chip and open a sheet.
    void restoreSession();
    loadLastGuideSection().then((id) => {
      useGuideStore.setState({ activeSectionId: id });
    });
  }, [loadPreferences, restoreSession]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void refreshUpdateStatus();
    void startUpdateListener()
      .then((unlisten) => {
        dispose = unlisten;
      })
      .catch(() => {});
    return () => dispose?.();
  }, [refreshUpdateStatus, startUpdateListener]);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    void checkForUpdate();
    const timer = window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [checkForUpdate]);

  // When this folder is in a group, the membership name is who is coding —
  // not the local picker, which can disagree with the roster and split work.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    void (async () => {
      await useSyncStore.getState().refreshStatus();
      const status = useSyncStore.getState().status;
      if (cancelled || !status?.signedIn || !status.inGroup) return;
      await refreshGroup();
      if (cancelled) return;
      const me = useSyncStore.getState().group?.members.find((m) => m.isYou);
      if (me) useProjectStore.getState().adoptCoderName(me.coderName);
      await useSyncStore.getState().syncNow({ silent: true });
      if (cancelled) return;
      // Registration above marks this device ready on a protocol-1 study, so
      // this is where a long-awaited upgrade finally happens — silently.
      await useSyncStore.getState().maybeAutoActivateV2();
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.path, refreshGroup]);

  useEffect(() => {
    if (!initialized || project || loading) return;
    if (!reopenLast) return;

    let cancelled = false;
    (async () => {
      try {
        const recents = await api.listRecentProjects();
        const latest = recents[0];
        if (!latest || cancelled) return;
        await openProject(latest.path);
      } catch {
        if (!cancelled) {
          setAutoOpenFailed({
            autoOpenFailed:
              "Could not reopen last project — it may have been moved. Open a .qcproj file from Recent projects.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialized, reopenLast, project, loading, openProject]);
}

export function useGlobalKeyboardShortcuts() {
  const project = useProjectStore((s) => s.project);
  const selectAdjacentSegment = useProjectStore((s) => s.selectAdjacentSegment);
  const requestExportProject = useProjectStore((s) => s.requestExportProject);
  const openGuide = useGuideStore((s) => s.openGuide);
  const closeGuide = useGuideStore((s) => s.closeGuide);
  const isGuideOpen = useGuideStore((s) => s.isOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      const inTextField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement;

      if (inTextField) {
        // ♿ Escape hands focus back to the transcript. Without it, ↑/↓ stayed
        // dead after typing a note until you reached for the mouse — in the
        // app's single most repeated motion. This is the keyboard way back.
        if (e.key === "Escape") {
          const selected = useProjectStore.getState().selectedSegmentId;
          const passage =
            selected &&
            document.getElementById(`segment-${selected}`);
          if (passage) {
            e.preventDefault();
            target.blur();
            passage.focus();
            return;
          }
        }
        if (e.key !== "Escape") return;
      }

      // The transcript listbox owns these while it has focus; running both
      // handlers would move the selection two passages per key press.
      if (
        target instanceof HTMLElement &&
        target.closest('[role="listbox"]') &&
        ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)
      ) {
        return;
      }

      if (e.key === "?" || (hasModKey(e) && e.key === "/")) {
        e.preventDefault();
        if (isGuideOpen) closeGuide();
        else openGuide();
        return;
      }

      if (!project) return;

      // Undo / redo. Platform-aware because `e.metaKey` is the *Windows key*
      // on Windows, not Control — every shortcut guarded by it alone was dead
      // there once before.
      if (e.key.toLowerCase() === "z" && hasModKey(e)) {
        e.preventDefault();
        if (e.shiftKey) void useProjectStore.getState().redoLastCoding();
        else void useProjectStore.getState().undoLastCoding();
        return;
      }

      // Ctrl+Y — the Windows redo habit. Free on macOS, where ⇧⌘Z rules.
      if (e.key.toLowerCase() === "y" && hasModKey(e)) {
        e.preventDefault();
        void useProjectStore.getState().redoLastCoding();
        return;
      }

      // "C to apply" is gone with the staging step it belonged to. Clicking a
      // code in the codebook now applies it directly, so there is no pending
      // intention for a key to commit.

      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectAdjacentSegment("next");
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        selectAdjacentSegment("prev");
        return;
      }

      if (hasModKey(e) && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        requestExportProject();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    project,
    selectAdjacentSegment,
    requestExportProject,
    openGuide,
    closeGuide,
    isGuideOpen,
  ]);
}
