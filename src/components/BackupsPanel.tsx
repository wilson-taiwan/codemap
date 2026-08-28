import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../lib/api";
import { formatBytes, formatRelativeTime } from "../lib/format";
import type { BackupInfo, BackupReason } from "../lib/types";
import { useProjectStore } from "../store/project-store";
import { Icon } from "./ui/Icon";
import { SideSheet } from "./ui/Surfaces";

/**
 * How each kind of snapshot describes itself.
 *
 * Deliberately not the raw enum. "pre-restore" is meaningless to somebody who
 * has never read the source, and the reason a snapshot exists is exactly what
 * tells them whether it is the one they want.
 */
const REASON: Record<BackupReason, { label: string; tone: string }> = {
  manual: { label: "You saved this", tone: "var(--accent)" },
  automatic: { label: "Automatic", tone: "var(--ink-3)" },
  "pre-restore": { label: "Before a restore", tone: "var(--warn)" },
};

function summarise(b: Pick<BackupInfo, "codes" | "interviews" | "coded_segments">) {
  const parts = [
    `${b.coded_segments} coded passage${b.coded_segments === 1 ? "" : "s"}`,
    `${b.codes} code${b.codes === 1 ? "" : "s"}`,
    `${b.interviews} interview${b.interviews === 1 ? "" : "s"}`,
  ];
  return parts.join(" · ");
}

export function BackupsPanel() {
  const { showBackups, setShowBackups, restoreFromBackup, showStatus } =
    useProjectStore(
      useShallow((s) => ({
        showBackups: s.showBackups,
        setShowBackups: s.setShowBackups,
        restoreFromBackup: s.restoreFromBackup,
        showStatus: s.showStatus,
      })),
    );

  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The snapshot awaiting a second click. Restoring overwrites a study, so it
  // is never one click away — but a modal on top of a side sheet is its own
  // kind of confusing, so the confirm expands in place instead.
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setBackups(await api.listBackups());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!showBackups) return;
    setConfirming(null);
    void refresh();
  }, [showBackups, refresh]);

  async function backUpNow() {
    setBusy(true);
    setError(null);
    try {
      await api.createBackup(note.trim() || undefined);
      setNote("");
      await refresh();
      showStatus("Backup saved.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doRestore(b: BackupInfo) {
    setBusy(true);
    setError(null);
    try {
      await restoreFromBackup(b.path);
      setConfirming(null);
      await refresh();
      setShowBackups(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(b: BackupInfo) {
    setBusy(true);
    try {
      await api.deleteBackup(b.path);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importFromDisk() {
    const file = await open({
      multiple: false,
      filters: [
        { name: "Fleuron backup", extensions: ["fleuronbak", "codemapbak"] },
      ],
      title: "Choose a backup file",
    });
    if (!file || Array.isArray(file)) return;

    setBusy(true);
    setError(null);
    try {
      await api.importBackup(file);
      await refresh();
      showStatus("Backup added to this project.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SideSheet
      open={showBackups}
      onClose={() => setShowBackups(false)}
      title="Backups"
      subtitle="Snapshots of this project you can go back to"
      width="max-w-lg"
    >
      <div className="scroll flex-1 p-4">
        <section
          className="rounded-[14px] p-3"
          style={{ background: "var(--fill)" }}
        >
          <p className="text-[12.5px]" style={{ color: "var(--ink-2)" }}>
            Fleuron takes a snapshot every time this project opens. You can also
            save one now — worth doing before anything you are unsure about.
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <input
              className="field field-sm"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What is this snapshot for? (optional)"
              aria-label="Note for this backup"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void backUpNow();
              }}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm shrink-0"
              disabled={busy}
              onClick={() => void backUpNow()}
            >
              <Icon name="check" size={13} />
              Back up now
            </button>
          </div>
        </section>

        {error && (
          <p
            className="mt-3 rounded-[11px] px-3 py-2 text-[12.5px]"
            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          >
            {error}
          </p>
        )}

        <div className="mb-2 mt-5 flex items-center gap-2">
          <h3 className="eyebrow">
            {backups.length} snapshot{backups.length === 1 ? "" : "s"}
          </h3>
          <button
            type="button"
            className="btn btn-ghost btn-sm ml-auto"
            disabled={busy}
            onClick={() => void importFromDisk()}
            title="Bring in a .fleuronbak file from somewhere else"
          >
            <Icon name="import" size={13} />
            Add from a file
          </button>
        </div>

        {loading ? (
          <p className="hint">Loading…</p>
        ) : backups.length === 0 ? (
          <p className="hint">
            No snapshots yet. One is taken automatically the next time this
            project opens.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {backups.map((b) => {
              const isConfirming = confirming === b.path;
              return (
                <li
                  key={b.path}
                  className="rounded-[13px] p-3"
                  style={{
                    background: "var(--fill)",
                    boxShadow: isConfirming
                      ? "inset 0 0 0 1px var(--warn)"
                      : "none",
                  }}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium">
                      {formatRelativeTime(b.created_at)}
                    </span>
                    <span
                      className="text-[11px] font-medium"
                      style={{ color: REASON[b.reason].tone }}
                    >
                      {REASON[b.reason].label}
                    </span>
                    <span
                      className="ml-auto text-[11px] tabular-nums"
                      style={{ color: "var(--ink-4)" }}
                    >
                      {formatBytes(b.size_bytes)}
                    </span>
                  </div>

                  <p className="mt-0.5 text-[12px]" style={{ color: "var(--ink-3)" }}>
                    {new Date(b.created_at).toLocaleString()}
                  </p>

                  <p className="mt-1 text-[12.5px]" style={{ color: "var(--ink-2)" }}>
                    {summarise(b)}
                  </p>

                  {b.note && (
                    <p
                      className="mt-1 text-[12.5px] italic"
                      style={{ color: "var(--ink-2)" }}
                    >
                      “{b.note}”
                    </p>
                  )}

                  {isConfirming ? (
                    <div
                      className="mt-2.5 rounded-[11px] p-2.5"
                      style={{ background: "var(--warn-soft)" }}
                    >
                      {/* Says what is lost and what is not. The second half is
                          the part that makes this a decision rather than a
                          gamble — a restore is itself undoable, and somebody
                          hovering over this button has no way to know that. */}
                      <p className="text-[12.5px]" style={{ color: "var(--ink)" }}>
                        This replaces everything in the project with the{" "}
                        {summarise(b)} above. Coding done since{" "}
                        {formatRelativeTime(b.created_at)} will be rolled back.
                      </p>
                      <p className="hint mt-1">
                        Your current state is saved as its own snapshot first, so
                        you can undo this.
                      </p>
                      <div className="mt-2 flex gap-1.5">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={busy}
                          onClick={() => void doRestore(b)}
                        >
                          {busy ? "Restoring…" : "Restore this snapshot"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() => setConfirming(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex gap-1.5">
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        disabled={busy}
                        onClick={() => setConfirming(b.path)}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => void remove(b)}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </SideSheet>
  );
}
