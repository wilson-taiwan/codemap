import { useCallback, useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/api";
import { basename, formatRelativeTime } from "../lib/format";
import { fileManagerName } from "../lib/platform";
import type { RecentProject } from "../lib/types";
import { useProjectStore } from "../store/project-store";
import { Icon } from "./ui/Icon";
import { openContextMenu } from "./ui/ContextMenu";

interface RecentProjectListProps {
  onOpenError?: (path: string, message: string) => void;
}

export function RecentProjectList({ onOpenError }: RecentProjectListProps) {
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(true);
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
    try {
      await openProject(recent.path);
    } catch (e) {
      onOpenError?.(recent.path, String(e));
    }
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
          </li>
        ))}
      </ul>
    </section>
  );
}
