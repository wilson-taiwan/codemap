import { open } from "@tauri-apps/plugin-dialog";
import { isWindows } from "./platform";

/** Extension for projects created from now on. */
export const PROJECT_EXT = ".codemap";

/**
 * Extensions the app will open. `.qcproj` is the pre-1.0 name and stays
 * openable indefinitely — projects already on Drive must not stop working
 * because the app got renamed.
 */
export const PROJECT_EXTENSIONS = ["codemap", "qcproj"] as const;

/**
 * Pick a project folder.
 *
 * This used to open two dialogs in sequence, because a `.codemap` could be
 * either a handoff bundle (a single file) or a working project (a folder), and
 * no native picker selects both. Handoff bundles no longer exist — coding
 * travels through sync and transcripts through Box — so a `.codemap` is now
 * only ever a folder, and one dialog is enough.
 *
 * macOS still needs the file-style picker: a `.codemap` folder is presented as
 * a package there, and a directory picker descends *into* it rather than
 * selecting it. Windows has no such notion and needs the directory picker.
 */
export async function pickProjectPath(): Promise<string | null> {
  const picked = isWindows
    ? await open({
        directory: true,
        multiple: false,
        title: "Choose a .codemap project folder",
      })
    : await open({
        multiple: false,
        title: "Open a Codemap project",
        filters: [
          { name: "Codemap Project", extensions: [...PROJECT_EXTENSIONS] },
        ],
      });
  return picked ? (picked as string) : null;
}
