import { useEffect, useState } from "react";
import { appConfirm } from "../store/confirm-store";
import { VOCABULARY } from "../lib/collab-vocabulary";
import { useShallow } from "zustand/react/shallow";
import { Modal } from "./ui/Surfaces";
import { Icon } from "./ui/Icon";
import { Menu } from "./ui/Menu";
import { TranscriptLinkPanel } from "./TranscriptLinkPanel";
import { SyncDiagnostics } from "./SyncDiagnostics";
import { BetaNotice } from "./BetaNotice";
import { api } from "../lib/api";
import { useSyncStore } from "../store/sync-store";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import type { GroupMember, SyncConflictDetail, SyncV2Readiness } from "../lib/types";

/**
 * The group: who is in it, its key, and whether coding is moving.
 *
 * A group is the whole collaborative story in one place — anyone holding the
 * key can join, and once in, everyone's coding meets in the middle. After
 * setup the sheet is only ever opened to read the roster, share the key, or
 * force a run.
 */
export function SyncSheet() {
  const {
    showSyncSheet,
    closeSyncSheet,
    status,
    syncing,
    error,
    lastOutcome,
    group,
    groupLoaded,
  } = useSyncStore(
      useShallow((s) => ({
        showSyncSheet: s.showSyncSheet,
        closeSyncSheet: s.closeSyncSheet,
        status: s.status,
        syncing: s.syncing,
        error: s.error,
        lastOutcome: s.lastOutcome,
        group: s.group,
        groupLoaded: s.groupLoaded,
      })),
    );
  const refreshGroup = useSyncStore((s) => s.refreshGroup);
  const createGroup = useSyncStore((s) => s.createGroup);
  const resetGroupKey = useSyncStore((s) => s.resetGroupKey);
  const renameSelf = useSyncStore((s) => s.renameSelf);
  const setMemberRole = useSyncStore((s) => s.setMemberRole);
  const removeMember = useSyncStore((s) => s.removeMember);
  const deleteGroup = useSyncStore((s) => s.deleteGroup);
  const project = useProjectStore((s) => s.project);
  const activeCoder = useProjectStore((s) => s.activeCoder);
  const syncNow = useSyncStore((s) => s.syncNow);
  const refreshStatus = useSyncStore((s) => s.refreshStatus);
  const joinAndBindOpenProject = useSyncStore((s) => s.joinAndBindOpenProject);
  const openSettings = useAppStore((s) => s.openSettings);

  const preferences = useAppStore((s) => s.preferences);
  const setPreferences = useAppStore((s) => s.setSyncServer);

  const [url, setUrl] = useState("");
  const [anonKey, setAnonKey] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  /**
   * The server form is a once-per-machine step on a self-hosted build, so it
   * collapses the moment it is done. Left expanded it is the first thing
   * between a coder and the Sync now button for the rest of the project's
   * life.
   */
  const [editingServer, setEditingServer] = useState(false);
  /** The create-a-group form's name field. */
  const [startName, setStartName] = useState("");
  const [starting, setStarting] = useState(false);
  /** Join-an-existing-group, on an unbound open project. */
  const [joinKey, setJoinKey] = useState("");
  const [joining, setJoining] = useState(false);
  /** The roster's inline rename: the name being typed, or null when closed. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteConfirmTitle, setDeleteConfirmTitle] = useState("");
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [showLinkPanel, setShowLinkPanel] = useState(false);
  const [v2Readiness, setV2Readiness] = useState<SyncV2Readiness | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflictDetail[]>([]);
  const [resolvingConflict, setResolvingConflict] = useState<string | null>(null);
  const [editingConflict, setEditingConflict] = useState<string | null>(null);
  const [customResolution, setCustomResolution] = useState("");
  // Inline failure states (v1.2): conflicts and leave-study no longer alert.
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!showSyncSheet) {
      return;
    }
    setUrl(preferences.sync_url ?? "");
    setAnonKey(preferences.sync_anon_key ?? "");
    setEditingServer(false);
    setRenaming(null);
    setStartName(activeCoder);
    setJoinKey("");
    setDeleteConfirmTitle("");
    setShowLinkPanel(false);
    void api.syncReconcilePendingUnbind().catch(() => {});
    void refreshStatus();
  }, [showSyncSheet, preferences.sync_url, preferences.sync_anon_key, refreshStatus, activeCoder]);

  const missing = lastOutcome?.missingTranscripts ?? [];
  const configured = status?.configured ?? false;
  const signedIn = status?.signedIn ?? false;
  const serverPreset = status?.serverPreset ?? false;
  const inGroup = status?.inGroup ?? false;
  const isGroupAdmin = status?.isGroupAdmin ?? false;
  const serverSchemaVersion = status?.serverSchemaVersion ?? null;
  const requiredServerSchema = status?.requiredServerSchema ?? 10;
  const schemaOutdated =
    serverSchemaVersion !== null && serverSchemaVersion < requiredServerSchema;

  useEffect(() => {
    let cancelled = false;
    if (!showSyncSheet || !signedIn || !inGroup || (serverSchemaVersion ?? 0) < 10) {
      setV2Readiness(null);
      setReadinessError(null);
      return;
    }
    void (async () => {
      try {
        const readiness = await api.syncV2Readiness();
        if (cancelled) return;
        setV2Readiness(readiness);
        setReadinessError(null);
        if (
          readiness.protocol === 1 &&
          readiness.members.length > 0 &&
          readiness.members.every((m) => m.ready)
        ) {
          // The sheet is itself an activation trigger: a long-open admin
          // session may have been waiting for the last teammate to update and
          // sync. The helper self-guards; refresh the view once it resolves.
          await useSyncStore.getState().maybeAutoActivateV2();
          if (cancelled) return;
          const fresh = await api.syncV2Readiness().catch(() => null);
          if (fresh && !cancelled) {
            setV2Readiness(fresh);
            setReadinessError(null);
          }
        }
      } catch {
        if (!cancelled) {
          setReadinessError("Protocol readiness is unavailable right now.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showSyncSheet, signedIn, inGroup, serverSchemaVersion]);

  async function refreshConflicts() {
    if (!showSyncSheet || !signedIn || !inGroup || status?.protocol !== 2) {
      setConflicts([]);
      return;
    }
    try {
      setConflicts(await api.listSyncConflicts());
    } catch {
      setConflicts([]);
    }
  }

  useEffect(() => {
    void refreshConflicts();
  }, [showSyncSheet, signedIn, inGroup, status?.protocol, status?.unresolvedConflictCount]);

  function conflictDisplayValue(value: unknown, fieldName: string) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const fields = value as Record<string, unknown>;
      const selected = fields[fieldName] ?? fields.name ?? fields.study_label;
      if (typeof selected === "string" || typeof selected === "number") return String(selected);
      if (typeof selected === "boolean") return selected ? "Yes" : "No";
    }
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return "A different value";
  }

  function customResolutionValue(conflict: SyncConflictDetail): string | number | boolean | null {
    const raw = customResolution.trim();
    if (conflict.field_name === "sort_order") {
      const numeric = Number(raw);
      if (!Number.isInteger(numeric)) throw new Error("Enter a whole-number sort order.");
      return numeric;
    }
    if (conflict.field_name === "is_retired" || conflict.field_name === "deleted") {
      if (raw !== "true" && raw !== "false") throw new Error("Enter true or false.");
      return raw === "true";
    }
    if (!raw) throw new Error("Enter a resolution.");
    const maxLength = conflict.entity_type === "code" && conflict.field_name === "name" ? 200 : 2000;
    if (raw.length > maxLength) throw new Error(`Keep this value under ${maxLength} characters.`);
    return raw;
  }

  async function resolveConflict(
    conflict: SyncConflictDetail,
    resolution: "keep_current" | "accept_proposal" | "custom",
  ) {
    if (resolvingConflict) return;
    setResolvingConflict(conflict.id);
    setConflictError(null);
    try {
      const customValue = resolution === "custom" ? customResolutionValue(conflict) : undefined;
      await api.syncV2ResolveConflict(conflict.id, resolution, customValue);
      setEditingConflict(null);
      setCustomResolution("");
      await syncNow();
      await Promise.all([refreshConflicts(), refreshStatus()]);
    } catch {
      // Non-blocking inline recovery: the sheet stays open with the conflict
      // row still resolvable; raw transport strings stay out of the UI.
      setConflictError(
        "This conflict could not be resolved just now. Check your connection and try again — nothing was lost.",
      );
    } finally {
      setResolvingConflict(null);
    }
  }

  async function confirmRemoveMember(m: GroupMember) {
    if (!m.userId) return;
    const ok = await appConfirm({
      title: `Remove ${m.coderName}?`,
      body: `${m.coderName}'s ${m.codedCount} coded segment${m.codedCount === 1 ? "" : "s"} stay in the study under their name. They lose access to the study.`,
      confirmLabel: `Remove ${m.coderName}`,
      cancelLabel: "Keep member",
      destructive: true,
      dedupeKey: "remove-member",
    });
    if (!ok) return;
    await removeMember(m.userId);
  }

  async function handleLeaveStudy() {
    const ok = await appConfirm({
      title: "Leave the group?",
      body: "Your coding and membership on the server will be removed. Transcripts on your computer are untouched.",
      confirmLabel: VOCABULARY.LEAVE_GROUP,
      cancelLabel: "Stay",
      destructive: true,
      dedupeKey: "leave-study",
    });
    if (!ok) return;
    try {
      await api.syncLeaveGroup();
      closeSyncSheet();
      await refreshStatus();
    } catch {
      setLeaveError(
        "Could not leave the study right now. Your work is safe on this computer — try again.",
      );
    }
  }

  async function handleDeleteGroup() {
    const title = group?.title || project?.title;
    if (!title || deleteConfirmTitle !== title || deletingGroup) return;
    setDeletingGroup(true);
    try {
      const ok = await deleteGroup(deleteConfirmTitle);
      if (ok) {
        setDeleteConfirmTitle("");
        closeSyncSheet();
      }
    } finally {
      setDeletingGroup(false);
    }
  }

  async function saveServer() {
    // The dashboard URL is the single most likely thing to be pasted here, and
    // it has no REST endpoint — the failure would surface much later as an
    // opaque 404, so it is worth catching at the point of entry.
    const trimmed = url.trim().replace(/\/+$/, "");
    await setPreferences(trimmed, anonKey.trim());
    await refreshStatus();
  }

  const dashboardUrlPasted = /supabase\.com\/dashboard/.test(url);

  /**
   * Accept a pasted connection block into either field, and split it back out.
   *
   * People paste what they were sent into whichever box they clicked first, so
   * recognising it in both is the difference between "it worked" and a support
   * message. A URL and a JWT are unambiguous — one starts with http, the other
   * is dot-separated base64 — so this needs no format of its own.
   */
  function applyPaste(raw: string, field: "url" | "key") {
    const parts = raw
      .split(/[\s\n]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const u = parts.find((p) => /^https?:\/\//i.test(p));
      const k = parts.find((p) => p.split(".").length === 3);
      if (u && k) {
        setUrl(u);
        setAnonKey(k);
        return;
      }
    }
    if (field === "url") setUrl(raw);
    else setAnonKey(raw);
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // Best-effort
    }
  }

  async function confirmResetKey() {
    const ok = await appConfirm({
      title: "Reset study key?",
      body: "Mint a fresh study key? The old key will stop working. Coders already in the study stay in.",
      confirmLabel: "Reset key",
      cancelLabel: "Keep key",
      destructive: true,
      dedupeKey: "reset-key",
    });
    if (!ok) return;
    await resetGroupKey();
  }

  async function commitRename() {
    if (!renaming || renameBusy) return;
    const next = renaming.trim();
    if (!next) return;
    setRenameBusy(true);
    try {
      await renameSelf(next);
      setRenaming(null);
    } finally {
      setRenameBusy(false);
    }
  }

  async function startGroup() {
    const name = startName.trim();
    if (!name || starting) return;
    setStarting(true);
    try {
      await createGroup(project?.title ?? "Fleuron study", name);
    } finally {
      setStarting(false);
    }
  }

  async function joinExisting() {
    const name = startName.trim();
    const key = joinKey.trim();
    if (!name || !key || joining) return;
    setJoining(true);
    try {
      await joinAndBindOpenProject(key, name);
    } finally {
      setJoining(false);
    }
  }

  return (
    <Modal
      open={showSyncSheet}
      onClose={closeSyncSheet}
      title="Study & sync"
      subtitle="Anyone with the study key can join. Coding decisions travel; collaboration sync excludes transcript text and memo fields."
      width="max-w-lg"
      footer={
        <>
          <button type="button" onClick={closeSyncSheet} className="btn btn-ghost">
            Close
          </button>
          {signedIn && inGroup && (
            <button
              type="button"
              onClick={() => void syncNow()}
              disabled={syncing}
              className="btn btn-primary"
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          )}
        </>
      }
    >
      <BetaNotice className="mb-4" />

      {error && (
        <div
          className="mb-4 rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
          role="alert"
        >
          {error.toLowerCase().includes("connection refused") ||
          error.toLowerCase().includes("error sending request")
            ? "Could not reach the sync server. Changes are saved locally on this computer; syncing will resume when reconnected."
            : error}
        </div>
      )}

      {schemaOutdated && (
        <div
          className="mb-4 rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: "var(--warning-soft)", color: "var(--warning)" }}
          role="alert"
        >
          Server update needed. Your server is running schema version {serverSchemaVersion}; this version of Fleuron requires version {requiredServerSchema}. Group creation and management are paused until the server is updated.
        </div>
      )}

      {/* A standing answer to "where am I in this?".
          
          Every section below is gated on a different combination of booleans —
          signed in, in a group, has ever synced — so sections appear and
          vanish as those change, and from the outside that reads as the sheet
          rearranging itself for no reason. The stages were always there; they
          were just never drawn. */}
      <ol className="mb-5 flex items-center gap-1.5 text-[11.5px]">
        {[
          { label: "Signed in", done: signedIn },
          { label: "Shared study", done: signedIn && inGroup },
          { label: "Syncing", done: signedIn && !!status?.lastSyncedAt },
        ].map((stage, i, all) => {
          // The first unfinished stage is the one to do next; everything after
          // it is simply not reachable yet, and saying so is kinder than
          // leaving three identical grey pills.
          const next = all.findIndex((x) => !x.done);
          const isNext = i === next;
          return (
            <li key={stage.label} className="flex items-center gap-1.5">
              <span
                className="flex items-center gap-1 rounded-full px-2 py-0.5"
                style={{
                  background: stage.done
                    ? "var(--ok-soft)"
                    : isNext
                      ? "var(--accent-soft)"
                      : "var(--fill)",
                  color: stage.done
                    ? "var(--ok)"
                    : isNext
                      ? "var(--accent)"
                      : "var(--ink-4)",
                }}
              >
                {stage.done && <Icon name="check" size={10} />}
                {stage.label}
              </span>
              {i < all.length - 1 && (
                <span style={{ color: "var(--ink-4)" }} aria-hidden="true">
                  ›
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {/* ── Server (self-hosted builds only) ────────────────────────────────
          A build that ships knowing its server never shows this: the address
          is infrastructure, and the group key is the only thing a coder
          should ever have to carry between machines. */}
      {!serverPreset && (configured && !editingServer ? (
        <section className="mb-5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="label">Sync server</h3>
            <p className="hint truncate" title={preferences.sync_url ?? ""}>
              {preferences.sync_url}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm shrink-0"
            onClick={() => setEditingServer(true)}
          >
            Change
          </button>
        </section>
      ) : (
      <section className="mb-5">
        <h3 className="label mb-1.5">Sync server</h3>
        <label className="hint mb-1 block" htmlFor="sync-url">
          Project URL
        </label>
        <input
          id="sync-url"
          className="field"
          value={url}
          onChange={(e) => applyPaste(e.target.value, "url")}
          placeholder="https://your-project.supabase.co  (or paste both lines here)"
          autoComplete="off"
          spellCheck={false}
        />
        {dashboardUrlPasted && (
          <p className="hint mt-1" style={{ color: "var(--warn)" }}>
            That looks like the dashboard address. The one you want ends in
            <code> .supabase.co</code> — Settings → Data API → Project URL.
          </p>
        )}

        <label className="hint mb-1 mt-3 block" htmlFor="sync-key">
          Anon key
        </label>
        <input
          id="sync-key"
          className="field"
          value={anonKey}
          onChange={(e) => applyPaste(e.target.value, "key")}
          placeholder="eyJhbGciOi…"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="hint mt-1">
          Safe to paste here — this key is designed to ship inside apps, and
          row-level security, not the key, is what protects the data.
        </p>
        <button
          type="button"
          onClick={() => void saveServer().then(() => setEditingServer(false))}
          className="btn btn-outline btn-sm mt-2"
          disabled={!url.trim() || !anonKey.trim()}
        >
          Save server
        </button>
      </section>
      ))}

      {/* ── Sign in (lives in Settings — this sheet is about the group) ── */}
      {configured && !signedIn && (
        <section className="mb-5">
          <h3 className="label mb-1.5">Sign in</h3>
          <p className="hint mb-2">
            The account is yours, not this study's. Sign in (or create an
            account) in Settings — a sign-in token stays in this machine's
            keychain so you do not re-enter the password every launch.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              closeSyncSheet();
              openSettings();
            }}
          >
            Open Settings
          </button>
        </section>
      )}

      {/* ── The study ─────────────────────────────────────────────────────── */}
      {signedIn && inGroup && groupLoaded && group && (
        <section className="mb-5">
          <h3 className="label mb-1.5">Study key</h3>
          <p className="hint mb-2">
            Anyone with this key can join — send it to your coder. They pick
            their own name when they join.
          </p>
          {group.groupKey ? (
            <div className="flex items-center gap-2">
              <p
                className="select-all font-mono text-[20px] tracking-[0.25em]"
                style={{ color: "var(--accent)" }}
              >
                {group.groupKey}
              </p>
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => void copy(group.groupKey, "key")}
              >
                {copied === "key" ? "Copied" : "Copy"}
              </button>
              {isGroupAdmin && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title="Mint a fresh key. The old one stops working; everyone already in stays in."
                  onClick={() => void confirmResetKey()}
                >
                  Reset key
                </button>
              )}
            </div>
          ) : (
            // A group created before keys existed has none yet. Minting one
            // is the same operation as resetting, just reached differently.
            isGroupAdmin ? (
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => void resetGroupKey()}
              >
                Create a study key
              </button>
            ) : null
          )}

          <h3 className="label mb-1.5 mt-5">Coders in this study</h3>
          <ul className="flex flex-col">
            {group.members.map((m) => (
              <li
                key={m.coderName}
                className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0"
                style={{ borderColor: "var(--g-rim)" }}
              >
                <div className="min-w-0">
                  {m.isYou && renaming !== null ? (
                    <div className="flex items-center gap-2">
                      <input
                        className="field field-sm"
                        value={renaming}
                        onChange={(e) => setRenaming(e.target.value)}
                        aria-label="Your name in this group"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-sm shrink-0"
                        disabled={!renaming.trim() || renameBusy}
                        onClick={() => void commitRename()}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm shrink-0"
                        onClick={() => setRenaming(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <span className="text-[13px] font-medium">
                      {m.coderName}
                      {m.isYou && (
                        <span className="hint ml-1.5">— you</span>
                      )}
                      {m.role === "admin" && (
                        <span className="chip ml-1.5 text-[10.5px]">Admin</span>
                      )}
                      {!m.role && (
                        <span className="hint ml-1.5 text-[11.5px]">(Former coder)</span>
                      )}
                      {m.isYou && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm ml-1"
                          title="Change the name your coding is filed under"
                          onClick={() => setRenaming(m.coderName)}
                        >
                          <Icon name="edit" size={12} />
                        </button>
                      )}
                    </span>
                  )}
                  <p className="hint">
                    {m.joinedAt
                      ? `Joined ${new Date(m.joinedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}`
                      : "Coded before the group existed"}
                    {m.lastActiveAt &&
                      ` · active ${relativeTime(m.lastActiveAt)}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="chip shrink-0">
                    {m.codedCount} passage{m.codedCount === 1 ? "" : "s"}
                  </span>
                  {isGroupAdmin && m.userId && m.role && (
                    <Menu
                      label="Member actions"
                      triggerClassName="btn btn-ghost btn-icon btn-sm"
                      items={[
                        m.role !== "admin"
                          ? {
                              label: "Make admin",
                              icon: "check",
                              onSelect: () => void setMemberRole(m.userId!, "admin"),
                            }
                          : {
                              label: "Make a coder",
                              icon: "people",
                              onSelect: () => void setMemberRole(m.userId!, "coder"),
                            },
                        {
                          label: "Remove from group…",
                          icon: "close",
                          destructive: true,
                          onSelect: () => void confirmRemoveMember(m),
                        },
                      ]}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>

          {(serverSchemaVersion ?? 0) >= 10 && (
            <section className="mt-6 border-t pt-5" style={{ borderColor: "var(--g-rim)" }}>
              {readinessError ? (
                <p className="hint">
                  Collaboration status could not be checked right now. Try again in a moment.
                </p>
              ) : !v2Readiness ? (
                <p className="hint">Checking collaboration status…</p>
              ) : v2Readiness.protocol === 2 ? (
                <span className="chip chip-ok">Real-time collaboration active</span>
              ) : v2Readiness.members.some((member) => !member.ready) ? (
                <p className="hint">
                  Real-time collaboration turns on automatically once everyone on
                  your team updates Fleuron.
                </p>
              ) : (
                <p className="hint">Setting up real-time collaboration…</p>
              )}
            </section>
          )}

          {isGroupAdmin && (
            <section className="mt-8 border-t pt-6" style={{ borderColor: "var(--danger-soft)" }}>
              <h3 className="label mb-1.5" style={{ color: "var(--danger)" }}>
                {VOCABULARY.DELETE_GROUP_FOR_EVERYONE}
              </h3>
              <p className="hint mb-3 text-[12.5px]">
                Permanently deletes the group from the sync server. Every coder's synced coding goes with it and cannot be recovered. Local project folders on each Mac remain intact as standalone studies.
              </p>
              <label className="hint mb-1 block text-[11.5px]" htmlFor="delete-group-confirm">
                Type <strong>{group.title || project?.title}</strong> to confirm:
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="delete-group-confirm"
                  className="field flex-1"
                  value={deleteConfirmTitle}
                  onChange={(e) => setDeleteConfirmTitle(e.target.value)}
                  placeholder={group.title || project?.title || ""}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn btn-danger btn-sm shrink-0"
                  disabled={
                    deleteConfirmTitle !== (group.title || project?.title) || deletingGroup
                  }
                  onClick={() => void handleDeleteGroup()}
                >
                  {deletingGroup ? "Deleting…" : VOCABULARY.DELETE_GROUP_FOR_EVERYONE}
                </button>
              </div>
            </section>
          )}
        </section>
      )}

      {/* The roster fetch failed — almost always the connection. Never show
          the create form instead: the group exists, and offering to mint it
          again would only produce a confusing conflict. */}
      {signedIn && inGroup && !groupLoaded && (
        <section className="mb-5">
          <h3 className="label mb-1.5">Group</h3>
          <p className="hint mb-2">
            The group details didn't load — check your connection.
          </p>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => void refreshGroup()}
          >
            Try again
          </button>
        </section>
      )}

      {/* ── Start or join, on an unbound folder ───────────────────────────── */}
      {signedIn && !inGroup && (
        <section className="mb-5">
          <h3 className="label mb-1.5">Your coder name</h3>
          <input
            id="start-name"
            className="field mb-4"
            value={startName}
            onChange={(e) => setStartName(e.target.value)}
            placeholder="Your name"
            autoComplete="off"
          />
          <p className="hint -mt-3 mb-4">
            Everything you code is filed under this. Colleagues name themselves
            when they join.
          </p>

          <h3 className="label mb-1.5">{VOCABULARY.SHARE_WITH_GROUP}</h3>
          <p className="hint mb-2">
            Shares “{project?.title ?? "this study"}” and gives it a study key.
            Send the key to your coder.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!startName.trim() || starting || joining}
            onClick={() => void startGroup()}
          >
            {starting ? "Sharing…" : VOCABULARY.SHARE_WITH_GROUP}
          </button>

          <h3 className="label mb-1.5 mt-5">Or join a shared study</h3>
          <p className="hint mb-2">
            Binds this folder to the study — it does not create a second copy.
            Refused if this folder is already in a different study.
          </p>
          <div className="flex items-center gap-2">
            <input
              className="field font-mono uppercase tracking-[0.2em]"
              value={joinKey}
              onChange={(e) => setJoinKey(e.target.value)}
              placeholder="ABCD-1234"
              autoComplete="off"
              spellCheck={false}
              maxLength={12}
              aria-label="Study key"
            />
            <button
              type="button"
              className="btn btn-outline btn-sm shrink-0"
              disabled={!startName.trim() || !joinKey.trim() || starting || joining}
              onClick={() => void joinExisting()}
            >
              {joining ? "Joining…" : "Join"}
            </button>
          </div>
        </section>
      )}

      {/* ── Status ────────────────────────────────────────────────────────── */}
      {signedIn && inGroup && (
        <section className="mb-5">
          <h3 className="label mb-1.5">Status</h3>
          <div className="flex flex-wrap items-center gap-2">
            <span className="chip chip-ok">
              <Icon name="people" size={12} /> Signed in
            </span>
            {status?.pendingChanges ? (
              <span className="chip chip-warn">
                {status.pendingChanges} change
                {status.pendingChanges === 1 ? "" : "s"} to send
              </span>
            ) : (
              <span className="chip">Everything sent</span>
            )}
            {status?.lastSyncedAt && (
              <span className="chip">
                Last sync {new Date(status.lastSyncedAt).toLocaleTimeString()}
              </span>
            )}
          </div>

          {lastOutcome && (
            <p className="hint mt-2">
              Sent {lastOutcome.pushedCoded} passage
              {lastOutcome.pushedCoded === 1 ? "" : "s"}, received{" "}
              {lastOutcome.pulledCoded}.
              {lastOutcome.newCodeNames.length > 0 && (
                <>
                  {" "}
                  New codes from your teammate:{" "}
                  <strong>{lastOutcome.newCodeNames.join(", ")}</strong>.
                </>
              )}
            </p>
          )}
        </section>
      )}

      {signedIn && inGroup && status?.protocol === 2 && conflicts.length > 0 && (
        <section className="mb-5 rounded-lg border p-3" style={{ borderColor: "var(--warning)" }}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <h3 className="label" style={{ color: "var(--warning)" }}>
              {conflicts.length} unresolved conflict{conflicts.length === 1 ? "" : "s"}
            </h3>
            <span className="chip chip-warn">Coding can continue</span>
          </div>
          <p className="hint mb-3">
            The current study value remains in use until someone chooses a resolution.
          </p>
          {conflictError && (
            <div role="status" className="notice notice-warn mb-3">
              {conflictError}
              <button
                type="button"
                className="btn btn-ghost btn-sm ml-2"
                onClick={() => setConflictError(null)}
              >
                Dismiss
              </button>
            </div>
          )}
          <div className="flex flex-col gap-3">
            {conflicts.map((conflict) => {
              const isEditing = editingConflict === conflict.id;
              const isResolving = resolvingConflict === conflict.id;
              const field = conflict.field_name === "__entity__"
                ? "new code"
                : conflict.field_name.replace(/_/g, " ");
              return (
                <article key={conflict.id} className="rounded border border-border/70 p-2.5 text-[12.5px]">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                    <strong>{conflict.entity_label}</strong>
                    <span className="text-muted">
                      {conflict.proposer_label ?? "Another coder"} · {new Date(conflict.created_at).toLocaleString()}
                    </span>
                  </div>
                  <p className="hint mt-1">Field: {field}</p>
                  <dl className="mt-2 grid gap-1">
                    <div>
                      <dt className="inline text-muted">Current: </dt>
                      <dd className="inline break-words">{conflictDisplayValue(conflict.current_value, conflict.field_name)}</dd>
                    </div>
                    <div>
                      <dt className="inline text-muted">Proposed: </dt>
                      <dd className="inline break-words">{conflictDisplayValue(conflict.proposed_value, conflict.field_name)}</dd>
                    </div>
                  </dl>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn btn-outline btn-xs"
                      disabled={Boolean(resolvingConflict)}
                      onClick={() => void resolveConflict(conflict, "keep_current")}
                    >
                      {isResolving ? "Resolving…" : "Keep current"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline btn-xs"
                      disabled={Boolean(resolvingConflict)}
                      onClick={() => void resolveConflict(conflict, "accept_proposal")}
                    >
                      Use proposed
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs"
                      disabled={Boolean(resolvingConflict)}
                      onClick={() => {
                        setEditingConflict(isEditing ? null : conflict.id);
                        setCustomResolution(conflictDisplayValue(conflict.current_value, conflict.field_name));
                      }}
                    >
                      Edit a resolution…
                    </button>
                  </div>
                  {isEditing && (
                    <div className="mt-2 flex items-center gap-2">
                      <label className="sr-only" htmlFor={`conflict-resolution-${conflict.id}`}>
                        Resolution for {field}
                      </label>
                      <input
                        id={`conflict-resolution-${conflict.id}`}
                        className="field min-w-0 flex-1"
                        value={customResolution}
                        onChange={(event) => setCustomResolution(event.target.value)}
                        maxLength={conflict.entity_type === "code" && conflict.field_name === "name" ? 200 : 2000}
                      />
                      <button
                        type="button"
                        className="btn btn-primary btn-xs shrink-0"
                        disabled={Boolean(resolvingConflict)}
                        onClick={() => void resolveConflict(conflict, "custom")}
                      >
                        Save resolution
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {signedIn && inGroup && <SyncDiagnostics status={status} />}

      {/* ── Transcripts this machine is missing ───────────────────────────── */}
      {missing.length > 0 && (
        <section
          className="mt-4 rounded-lg px-3 py-2"
          style={{ background: "var(--warn-soft)" }}
        >
          <h3 className="label mb-1" style={{ color: "var(--warn)" }}>
            Transcripts to import
          </h3>
          <p className="hint mb-1.5">
            Your coder has these. Import the same file from your shared folder,
            using the same participant ID — coding will line up on its own.
          </p>
          <ul className="flex flex-col gap-0.5">
            {missing.map((m) => (
              <li key={m.studyLabel} className="text-[12.5px]">
                <strong>{m.studyLabel}</strong>{" "}
                {m.mismatched ? (
                  <span style={{ color: "var(--warn)" }}>
                    — you imported a different file for this one
                  </span>
                ) : (
                  <span className="hint">
                    — {m.segmentCount} passage
                    {m.segmentCount === 1 ? "" : "s"}, not imported here
                  </span>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowLinkPanel(true)}
              className="btn btn-outline btn-sm gap-1.5"
            >
              <Icon name="search" size={13} />
              Link transcripts…
            </button>
          </div>
        </section>
      )}

      {signedIn && inGroup && !isGroupAdmin && (
        <div className="mt-6 border-t pt-4 text-center">
          {leaveError && (
            <div role="status" className="notice notice-warn mb-2">
              {leaveError}
              <button
                type="button"
                className="btn btn-ghost btn-sm ml-2"
                onClick={() => setLeaveError(null)}
              >
                Dismiss
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => void handleLeaveStudy()}
            className="btn btn-ghost btn-sm"
            style={{ color: "var(--danger)" }}
          >
            Leave this study…
          </button>
        </div>
      )}

      <TranscriptLinkPanel
        open={showLinkPanel}
        onClose={() => setShowLinkPanel(false)}
      />
    </Modal>
  );
}

/** "5h ago", "3d ago" — the roster's at-a-glance freshness. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "at some point";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
