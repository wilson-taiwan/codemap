import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { pickProjectPath } from "../lib/open-project";
import { useGuideStore } from "../store/guide-store";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";

/**
 * A launch path is claimed once per page load, not once per mount.
 *
 * StrictMode mounts this hook twice in dev and `consumePendingOpen` drains the
 * queue, so without the latch the second mount finds nothing and the first has
 * already been torn down — the double-click would work in a release build and
 * appear dead in dev, which is the worst possible way to test this path.
 */
let launchPathClaimed = false;

export function useMenuEvents() {
  const openProject = useProjectStore((s) => s.openProject);
  const requestExportProject = useProjectStore((s) => s.requestExportProject);
  const requestCloseProject = useProjectStore((s) => s.requestCloseProject);
  const setShowProjectFiles = useProjectStore((s) => s.setShowProjectFiles);
  const openGuide = useGuideStore((s) => s.openGuide);
  const openAbout = useAppStore((s) => s.openAbout);
  const openSetup = useAppStore((s) => s.openSetup);

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let disposed = false;

    listen("menu-new-project", () => {
      openSetup();
    }).then((u) => unsubs.push(u));

    listen("menu-open-project", async () => {
      const selected = await pickProjectPath();
      if (selected) await openProject(selected);
    }).then((u) => unsubs.push(u));

    // Double-clicking a project in Finder or Explorer. The claim below has to
    // happen *after* this listener exists — `consumePendingOpen` is what tells
    // Rust the frontend is listening, so a file opened in the gap between the
    // two would be emitted into a page with nowhere to receive it.
    void (async () => {
      const unsub = await listen("open-project-path", async (event) => {
        const path = event.payload as string;
        if (path) await openProject(path);
      });
      if (disposed) unsub();
      else unsubs.push(unsub);

      if (launchPathClaimed) return;
      launchPathClaimed = true;
      for (const path of await api.consumePendingOpen()) {
        // The store records the failure and re-throws; one bad path in the
        // queue should not strand the rest.
        await openProject(path).catch(() => {});
      }
    })();

    listen("menu-export", () => {
      requestExportProject();
    }).then((u) => unsubs.push(u));

    listen("menu-close-project", () => {
      requestCloseProject();
    }).then((u) => unsubs.push(u));

    listen("menu-open-guide", () => {
      openGuide();
    }).then((u) => unsubs.push(u));

    listen("menu-project-files", () => {
      setShowProjectFiles(true);
    }).then((u) => unsubs.push(u));

    listen("menu-about", () => {
      openAbout();
    }).then((u) => unsubs.push(u));

    return () => {
      disposed = true;
      unsubs.forEach((u) => u());
    };
  }, [
    openProject,
    requestExportProject,
    requestCloseProject,
    setShowProjectFiles,
    openGuide,
    openAbout,
    openSetup,
  ]);
}
