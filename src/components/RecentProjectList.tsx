import { useCallback, useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/api";
import { basename, formatRelativeTime } from "../lib/format";
import {
  fileAccessCopy,
  parseFileError,
  recoveryActions,
  type FileAccessUi,
} from "../lib/file-access";
import { fileManagerName } from "../lib/platform";
import type { RecentProject } from "../lib/types";
import { useProjectStore } from "../store/project-store";
import { Icon } from "./ui/Icon";
import { openContextMenu } from "./ui/ContextMenu";

interface RecentProjectListProps {
  /** When provided, "How to fix access" opens it (wired to Trust Center). */
  onHelp?: () => void;
}

interface FailedRow {
  path: string;
  ui: FileAccessUi;
}

export function RecentProjectList({ onHelp }: RecentProjectListProps) {
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [failedRow, setFailedRow] = useState<FailedRow | null>(null);
  const { openProject, loading: projectLoading } = useProjectStore(
    useShallow((s) => ({ openProject: s.openProject, loading: s.loading })),
  );

  const loadRecents = useCallback(async () => {
    try {
      setRecents(await api.listRecentProjects());
    } catch {
      setRecents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecents();
  }, [loadRecents]);

  async function handleOpen(recent: RecentProject) {
    setFailedRow(null);
    try {
      await openProject(recent.path);
    } catch (e) {
      // The row stays visible regardless — a failed open must never cost the
      // user their place in Recents. Raw errors classify into safe copy.
      const ui =
        parseFileError(e) ??
        ({
          category: "invalid_project",
          message: "Could not open this study.",
          detail: String(e),
        } satisfies FileAccessUi);
      setFailedRow({ path: recent.path, ui });
    }
  }

  /** Locate folder: the user picks where the study moved to; try opening it. */
  async function locateFailedFolder() {
    if (!failedRow) return;
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: `Locate “${basename(failedRow.path)}”`,
      });
      if (typeof picked !== "string") return;
      setFailedRow(null);
      await openProject(picked);
    } catch (e) {
      const ui =
        parseFileError(e) ??
        ({
          category: "invalid_project",
          message: "Could not open this study.",
          detail: String(e),
        } satisfies FileAccessUi);
      setFailedRow({ path: failedRow.path, ui });
    }
  }

  async function removeFailedRow() {
    if (!failedRow) return;
    setRecents(await api.removeRecentProject(failedRow.path));
    setFailedRow(null);
  }

  async function removeRecent(path: string) {
    setRecents(await api.removeRecentProject(path));
  }

  async function handleRemove(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    await removeRecent(path);
  }

  async function revealRecent(path: string) {
    try {
      await revealItemInDir(path);
    } catch {
      // Revealing is a convenience here; a missing folder is not worth a dialog.
    }
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      // Same — no clipboard, no harm.
    }
  }

  if (loading || recents.length === 0) return null;

  return (
    <section className="anim-rise mt-10 w-full">
      <h2 className="eyebrow mb-2.5 px-1">Recent</h2>
      <ul className="flex flex-col gap-1">
        {recents.map((recent) => (
          <li key={recent.path}>
            <div
              onContextMenu={(e) =>
                openContextMenu(e, [
                  {
                    label: "Open project",
                    icon: "folder",
                    onSelect: () => handleOpen(recent),
                    disabled: projectLoading,
                  },
                  {
                    label: `Show in ${fileManagerName}`,
                    icon: "search",
                    onSelect: () => revealRecent(recent.path),
                  },
                  {
                    label: "Copy path",
                    icon: "note",
                    onSelect: () => copyPath(recent.path),
                  },
                  {
                    // Removing the entry, not the project — say so, because
                    // the two are easy to confuse in a list like this.
                    label: "Remove from Recent",
                    icon: "close",
                    onSelect: () => removeRecent(recent.path),
                    destructive: true,
                  },
                ])
              }
              className="group flex items-center gap-3 rounded-[13px] px-3 py-2.5 transition-colors"
              style={{ background: "transparent" }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--fill)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <button
                type="button"
                onClick={() => handleOpen(recent)}
                disabled={projectLoading}
                className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-50"
              >
                <Icon
                  name="layers"
                  size={16}
                  className="shrink-0 opacity-45"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">
                    {recent.title}
                  </span>
                  <span
                    className="mt-0.5 block truncate text-[11.5px]"
                    style={{ color: "var(--ink-3)" }}
                  >
                    {basename(recent.path)} · opened{" "}
                    {formatRelativeTime(recent.last_opened_at)}
                    
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => handleRemove(recent.path, e)}
                aria-label={`Remove ${recent.title} from recents`}
                className="btn btn-ghost btn-icon shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
            {failedRow?.path === recent.path && (
              <FailedOpenCard
                failedRow={failedRow}
                onLocate={locateFailedFolder}
                onDismiss={() => setFailedRow(null)}
                onRemove={removeFailedRow}
                onHelp={() => {
                  setFailedRow(null);
                  onHelp?.();
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Inline recovery state for a recent row whose study could not open. Offers
 * the four safe paths forward; never renders the raw OS/database error, which
 * stays inside the failedRow's `detail` for optional diagnostics later.
 */
function FailedOpenCard({
  failedRow,
  onLocate,
  onDismiss,
  onRemove,
  onHelp,
}: {
  failedRow: FailedRow;
  onLocate: () => void;
  onDismiss: () => void;
  onRemove: () => void;
  onHelp: () => void;
}) {
  const { title, recovery } = fileAccessCopy(failedRow.ui);
  const actions = recoveryActions(failedRow.ui.category);
  return (
    <div
      role="alert"
      className="notice notice-warn mt-1 mb-2 ml-3 mr-3"
    >
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-[12.5px]">{recovery}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {actions.includes("locate-folder") && (
          <button type="button" className="btn btn-outline btn-sm" onClick={onLocate}>
            Locate folder
          </button>
        )}
        {actions.includes("choose-another") && (
          <button type="button" className="btn btn-outline btn-sm" onClick={onDismiss}>
            Choose another study
          </button>
        )}
        {actions.includes("remove-recent") && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}>
            Remove from recent
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm underline" onClick={onHelp}>
          How to fix access
        </button>
      </div>
      {failedRow.ui.detail && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11.5px]" style={{ color: "var(--ink-3)" }}>
            Technical details
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-[11px]" style={{ color: "var(--ink-3)" }}>
            {failedRow.ui.detail}
          </pre>
        </details>
      )}
    </div>
  );
}
