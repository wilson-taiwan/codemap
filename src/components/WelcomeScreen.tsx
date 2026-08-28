import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { pickProjectPath } from "../lib/open-project";
import { useGuideStore } from "../store/guide-store";
import { useAppStore, onboardingChoiceSeen } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { useSyncStore } from "../store/sync-store";
import { api } from "../lib/api";
import { basename, formatRelativeTime } from "../lib/format";
import { fileManagerName, trashName } from "../lib/platform";
import { deriveHomeRows, formatMembersPhrase, getRowReadiness } from "../lib/home-rows";
import type { MembershipSummary, RecentProject } from "../lib/types";
import { Icon, type IconName } from "./ui/Icon";
import { Modal } from "./ui/Surfaces";
import { ContextMenuHost, openContextMenu } from "./ui/ContextMenu";
import { AccountForm } from "./AccountForm";
import { CollaborationDisclosure } from "./CollaborationDisclosure";
import { UpdateAction } from "./UpdateAction";

export function WelcomeScreen() {
  const { openProject, loading, error } = useProjectStore(
    useShallow((s) => ({
      openProject: s.openProject,
      loading: s.loading,
      error: s.error,
    })),
  );
  const autoOpenFailed = useAppStore((s) => s.autoOpenFailed);
  const clearAutoOpenFailed = useAppStore((s) => s.clearAutoOpenFailed);
  const openSetup = useAppStore((s) => s.openSetup);
  const openJoinStudy = useAppStore((s) => s.openJoinStudy);
  const openJoinStudyForMembership = useAppStore(
    (s) => s.openJoinStudyForMembership,
  );
  const openAbout = useAppStore((s) => s.openAbout);
  const openSettings = useAppStore((s) => s.openSettings);
  const initialized = useAppStore((s) => s.initialized);
  const preferences = useAppStore((s) => s.preferences);
  const setSigninPromptSeen = useAppStore((s) => s.setSigninPromptSeen);
  const setOnboardingChoiceSeen = useAppStore((s) => s.setOnboardingChoiceSeen);

  // First-run UI waits for BOTH app preferences and the silent session
  // restore; deciding earlier flashes the choice at returning signed-in users.
  const sessionRestoreComplete = useSyncStore((s) => s.sessionRestoreComplete);

  /**
   * Intent-first onboarding (v1.2): local-first or collaborate. `step`
   * advances only inside the collaboration path; Back returns to cards.
   */
  const [onboardingStep, setOnboardingStep] = useState<
    "choice" | "disclosure" | "account"
  >("choice");

  const signedIn = useSyncStore((s) => s.status?.signedIn ?? false);
  const signedInEmail = useSyncStore((s) => s.status?.signedInEmail);
  const refreshStatus = useSyncStore((s) => s.refreshStatus);
  const openGuide = useGuideStore((s) => s.openGuide);

  const [recentError, setRecentError] = useState<string | null>(null);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [cachedMemberships, setCachedMemberships] = useState<MembershipSummary[]>([]);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [liveMemberships, setLiveMemberships] = useState<MembershipSummary[] | null>(null);

  const [removalState, setRemovalState] = useState<{
    target: {
      title: string;
      path?: string;
      projectId?: string;
      isBound: boolean;
      isAdmin: boolean;
      isRemoteOnly?: boolean;
    };
    summary?: {
      interview_count: number;
      coded_segment_count: number;
      memo_count: number;
    } | null;
    mode: "detach" | "leave" | "delete_group" | "delete_solo";
    alsoDeleteFolder: boolean;
    confirmTitleInput: string;
  } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const loadData = useCallback(async () => {
    // 1. First paint from cache and local recents
    try {
      const cache = await api.listCachedMemberships();
      setCachedMemberships(cache.memberships || []);
      setCachedAt(cache.cachedAt || null);
    } catch {
      // Offline fallback
    }

    // 2. Fetch fresh local recents
    try {
      const r = await api.listRecentProjects();
      setRecents(r);
    } catch (e) {
      setRecentError(`Could not read recent projects: ${String(e)}`);
    }

    // 3. Background refresh of live memberships if signed in
    if (signedIn) {
      try {
        const live = await api.listMemberships();
        setLiveMemberships(live);
      } catch (e) {
        if (e instanceof Error && e.name === "Unauthorized") {
          refreshStatus();
        }
      }
    }
  }, [signedIn, refreshStatus]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleOpen() {
    setRecentError(null);
    try {
      const selected = await pickProjectPath();
      if (selected && typeof selected === "string") {
        await openProject(selected);
      }
    } catch (e) {
      setRecentError(String(e));
    }
  }

  async function handleOpenPath(path: string) {
    setRecentError(null);
    try {
      await openProject(path);
    } catch (e) {
      setRecentError(`Could not open project — ${String(e)}`);
    }
  }

  async function handleShareProject(path: string) {
    setRecentError(null);
    try {
      await openProject(path);
      useSyncStore.getState().openSyncSheet();
    } catch (e) {
      setRecentError(`Could not open project for sharing — ${String(e)}`);
    }
  }

  async function requestRemoveStudy(
    target: {
      title: string;
      path?: string;
      projectId?: string;
      isBound: boolean;
      isAdmin?: boolean;
      isRemoteOnly?: boolean;
    },
    initialMode?: "detach" | "leave" | "delete_group" | "delete_solo",
  ) {
    let summary: {
      interview_count: number;
      coded_segment_count: number;
      memo_count: number;
    } | null = null;

    if (target.path) {
      try {
        summary = await api.projectDeletionSummary(target.path);
      } catch {
        summary = null;
      }
    }

    const defaultMode: "detach" | "leave" | "delete_group" | "delete_solo" =
      initialMode ??
      (!target.isBound
        ? "delete_solo"
        : target.isRemoteOnly
          ? "leave"
          : "detach");

    setRemovalState({
      target: {
        ...target,
        isAdmin: !!target.isAdmin,
      },
      summary,
      mode: defaultMode,
      alsoDeleteFolder: false,
      confirmTitleInput: "",
    });
  }

  async function confirmRemoval() {
    if (!removalState || actionBusy) return;
    const { target, mode, alsoDeleteFolder, confirmTitleInput } = removalState;
    setActionBusy(true);
    try {
      if (mode === "delete_solo") {
        if (target.path) {
          await api.deleteProjectFolder(target.path);
          setRecents(await api.removeRecentProject(target.path));
        }
      } else if (mode === "detach") {
        await api.syncDetachLocal(target.projectId);
      } else if (mode === "leave") {
        await api.syncLeaveGroup(target.projectId);
        if (alsoDeleteFolder && target.path) {
          await api.deleteProjectFolder(target.path);
          setRecents(await api.removeRecentProject(target.path));
        }
      } else if (mode === "delete_group") {
        if (confirmTitleInput.trim() !== target.title.trim()) {
          throw new Error("Confirmation title does not match.");
        }
        await api.syncDeleteGroup(target.title, target.projectId);
        if (alsoDeleteFolder && target.path) {
          await api.deleteProjectFolder(target.path);
          setRecents(await api.removeRecentProject(target.path));
        }
      }
      setRemovalState(null);
      await loadData();
    } catch (e) {
      setRecentError(`Could not remove study — ${String(e)}`);
    } finally {
      setActionBusy(false);
    }
  }

  async function removeRecent(path: string) {
    setRecents(await api.removeRecentProject(path));
  }

  async function revealRecent(path: string) {
    try {
      await revealItemInDir(path);
    } catch {
      // Best-effort convenience
    }
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      // Best-effort convenience
    }
  }

  // First-run intent choice (v1.2). Migration truth table lives in
  // app-store.ts (`onboardingChoiceSeen`) so it is unit-testable.
  const showFirstRunChoice =
    initialized &&
    sessionRestoreComplete &&
    !onboardingChoiceSeen(preferences) &&
    !signedIn;

  if (showFirstRunChoice) {
    return (
      <div className="flex h-screen flex-col">
        {/* The only thing that moves the window on this screen. macOS hides the
            titlebar, so without a drag region the window cannot be moved at all
            until a study is open — which is what shipped from v0.22 to v0.24.
            `.traffic-pad` reserves the traffic-light gutter on macOS and collapses
            elsewhere; see the note at src/index.css:413. */}
        <div
          data-tauri-drag-region="deep"
          className="traffic-pad fixed inset-x-0 top-0 z-10 h-[38px]"
          aria-hidden="true"
        />
        <ContextMenuHost />
        <div className="scroll flex flex-1 flex-col px-6 py-10">
          <div className="mx-auto my-auto flex w-full max-w-md flex-col items-center py-6">
            <header className="anim-rise flex flex-col items-center text-center">
              <Mark />
              <h1 className="wordmark mt-4 text-[28px]">Welcome to Fleuron</h1>
              <p className="hint mt-2 max-w-sm text-[13px]">
                How do you want to work? You can change your mind at any time.
              </p>
            </header>

            {onboardingStep === "choice" && (
              <div className="anim-rise mt-8 flex w-full flex-col gap-4">
                {/* Work locally — recommended, primary, one choice, no account. */}
                <button
                  type="button"
                  onClick={() => void setOnboardingChoiceSeen(true)}
                  disabled={loading}
                  className="w-full rounded-[16px] border border-[var(--border)] bg-[var(--surface)] p-5 text-left shadow-sm transition-colors hover:bg-[var(--fill)]"
                >
                  <span className="flex items-center gap-2.5">
                    <Icon name="layers" size={18} />
                    <span className="text-[15px] font-semibold">Work locally</span>
                    <span
                      className="ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
                    >
                      Recommended
                    </span>
                  </span>
                  <span className="mt-2 block text-[13px]" style={{ color: "var(--ink-2)" }}>
                    No account. Create, code, memo, and export on this computer.
                    Fleuron checks GitHub for updates unless you turn that off.
                  </span>
                </button>

                {/* Collaborate — secondary; account UI only after the disclosure. */}
                <button
                  type="button"
                  onClick={() => setOnboardingStep("disclosure")}
                  className="w-full rounded-[16px] border border-[var(--border)] bg-[var(--surface)] p-5 text-left transition-colors hover:bg-[var(--fill)]"
                >
                  <span className="flex items-center gap-2.5">
                    <Icon name="people" size={18} />
                    <span className="text-[15px] font-semibold">
                      Collaborate with a team
                    </span>
                  </span>
                  <span className="mt-2 block text-[13px]" style={{ color: "var(--ink-2)" }}>
                    Sign in to see and sync shared studies with colleagues.
                  </span>
                </button>

                {/* Non-blocking trust link: the user already passed the OS
                    warning, so no full warning repeat lives here. */}
                <button
                  type="button"
                  onClick={() => useAppStore.getState().openTrustCenter()}
                  className="btn btn-ghost mt-2 self-center gap-1.5 text-[12.5px]"
                >
                  <Icon name="shield" size={13} />
                  Trust, privacy &amp; permissions
                </button>
              </div>
            )}

            {onboardingStep === "disclosure" && (
              <div className="anim-rise mt-8 w-full rounded-[16px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
                <h2 className="text-[15px] font-semibold">Collaborate with a team</h2>
                <CollaborationDisclosure className="mt-3" />
                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setOnboardingStep("account")}
                    className="btn btn-primary"
                  >
                    Continue to account
                  </button>
                  <button
                    type="button"
                    onClick={() => setOnboardingStep("choice")}
                    className="btn btn-ghost"
                  >
                    Back
                  </button>
                </div>
              </div>
            )}

            {onboardingStep === "account" && (
              <div className="anim-rise mt-8 w-full rounded-[16px] border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
                <AccountForm
                  idPrefix="firstrun"
                  autoFocus
                  onSignedIn={() => {
                    void setOnboardingChoiceSeen(true);
                    void setSigninPromptSeen(true);
                    void loadData();
                  }}
                />
                <button
                  type="button"
                  onClick={() => setOnboardingStep("choice")}
                  className="btn btn-ghost mt-3"
                >
                  Back
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const rows = deriveHomeRows({
    recents,
    cachedMemberships,
    liveMemberships,
    signedIn,
  });

  const isEmpty = rows.length === 0;
  const problem = error || recentError || autoOpenFailed;

  return (
    <div className="flex h-screen flex-col">
      {/* The only thing that moves the window on this screen. macOS hides the
          titlebar, so without a drag region the window cannot be moved at all
          until a study is open — which is what shipped from v0.22 to v0.24.
          `.traffic-pad` reserves the traffic-light gutter on macOS and collapses
          elsewhere; see the note at src/index.css:413. */}
      <div
        data-tauri-drag-region="deep"
        className="traffic-pad fixed inset-x-0 top-0 z-10 h-[38px]"
        aria-hidden="true"
      />
      <ContextMenuHost />

      {/* Top right quick actions */}
      <div
        data-tauri-drag-region="false"
        className="absolute right-4 top-4 z-20 flex items-center gap-2"
      >
        <UpdateAction />
        {signedIn ? (
          <button
            type="button"
            onClick={openSettings}
            className="btn btn-ghost btn-sm gap-1.5 text-[12px]"
            title={signedInEmail ? `Signed in as ${signedInEmail}` : "Signed in"}
          >
            <Icon name="people" size={13} />
            <span className="max-w-[140px] truncate">{signedInEmail || "Account"}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={openSettings}
            className="btn btn-ghost btn-sm gap-1.5 text-[12px]"
          >
            <Icon name="people" size={13} />
            Sign in
          </button>
        )}
        <button
          type="button"
          onClick={() => useAppStore.getState().openTrustCenter()}
          className="btn btn-ghost btn-sm"
          aria-label="Trust & permissions"
          title="Trust & permissions"
        >
          <Icon name="shield" size={14} />
        </button>
        <button
          type="button"
          onClick={openSettings}
          className="btn btn-ghost btn-sm"
          aria-label="Settings"
        >
          <Icon name="settings" size={14} />
        </button>
        <button
          type="button"
          onClick={openAbout}
          className="btn btn-ghost btn-sm"
          aria-label="About Fleuron"
        >
          <Icon name="help" size={14} />
        </button>
      </div>

      <div className="scroll flex flex-1 flex-col px-6 pb-10">
        <div className="mx-auto my-auto flex w-full max-w-lg flex-col items-center py-6">
          <header className="anim-rise flex flex-col items-center text-center">
            <Mark />
            <h1 className="wordmark mt-4 text-[32px]">Fleuron</h1>
            <p className="hint mt-2 max-w-sm text-[13px]">
              Code interview transcripts with a living codebook, and export
              coded segments for writing up.
            </p>
          </header>

          {problem && (
            <div
              role="alert"
              className="anim-rise mt-6 flex w-full items-start gap-2.5 rounded-[14px] px-3.5 py-3 text-[13px]"
              style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            >
              <Icon name="alert" size={16} />
              <span className="flex-1">{problem}</span>
              {autoOpenFailed && (
                <button
                  type="button"
                  onClick={() => clearAutoOpenFailed()}
                  className="btn btn-ghost btn-sm shrink-0"
                >
                  Dismiss
                </button>
              )}
            </div>
          )}

          {isEmpty ? (
            /* Empty state: intent-first ordering — local start is primary,
               join is secondary, open remains third. */
            <div className="anim-rise mt-8 flex w-full flex-col gap-2.5">
              <HomeCard
                icon="plus"
                primary
                disabled={loading}
                onClick={() => openSetup()}
                title="Start a local study"
                subtitle="No account needed — you can collaborate later"
              />
              <HomeCard
                icon="people"
                disabled={loading}
                onClick={openJoinStudy}
                title="Join a collaborative study"
                subtitle="A colleague started one and sent you its key"
              />
              <HomeCard
                icon="folder"
                disabled={loading}
                onClick={handleOpen}
                title="Open an existing study"
                subtitle="A .fleuron or .qcproj folder on this computer"
              />
            </div>
          ) : (
            /* Non-empty state: Compact actions row + single unified Studies section (Task 12) */
            <div className="anim-rise mt-8 flex w-full flex-col">
              {/* Compact action row */}
              <div className="mb-8 flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => openSetup()}
                  disabled={loading}
                  className="btn btn-outline btn-sm gap-1.5"
                >
                  <Icon name="plus" size={13} />
                  New study
                </button>
                <button
                  type="button"
                  onClick={handleOpen}
                  disabled={loading}
                  className="btn btn-outline btn-sm gap-1.5"
                >
                  <Icon name="folder" size={13} />
                  Open a folder
                </button>
                <button
                  type="button"
                  onClick={openJoinStudy}
                  disabled={loading}
                  className="btn btn-outline btn-sm gap-1.5"
                >
                  <Icon name="people" size={13} />
                  Join with a key
                </button>
              </div>

              {/* Single unified Studies section */}
              <section className="mb-8 w-full">
                <div className="mb-2.5 flex items-baseline justify-between px-1">
                  <h2 className="eyebrow">Studies</h2>
                  {liveMemberships === null && cachedAt && (
                    <span className="hint text-[11px]">
                      Last checked {formatRelativeTime(cachedAt)}
                    </span>
                  )}
                </div>
                <ul className="flex flex-col gap-1.5">
                  {rows.map((row) => {
                    const readiness = getRowReadiness(row);
                    if (row.kind === "bound-group") {
                      const membersText = formatMembersPhrase(
                        row.members,
                        row.coderName,
                      );
                      return (
                        <li key={row.path}>
                          <div
                            onContextMenu={(e) =>
                              openContextMenu(e, [
                                {
                                  label: "Open study",
                                  icon: "folder",
                                  onSelect: () => handleOpenPath(row.path),
                                  disabled: loading,
                                },
                                {
                                  label: `Show in ${fileManagerName}`,
                                  icon: "search",
                                  onSelect: () => revealRecent(row.path),
                                },
                                {
                                  label: "Copy path",
                                  icon: "note",
                                  onSelect: () => copyPath(row.path),
                                },
                                {
                                  label: "Remove from this Mac…",
                                  icon: "close",
                                  onSelect: () =>
                                    requestRemoveStudy(
                                      {
                                        title: row.title,
                                        path: row.path,
                                        projectId: row.projectId,
                                        isBound: true,
                                        isAdmin: row.role === "admin",
                                      },
                                      "detach",
                                    ),
                                },
                                {
                                  label: "Leave study…",
                                  icon: "close",
                                  onSelect: () =>
                                    requestRemoveStudy(
                                      {
                                        title: row.title,
                                        path: row.path,
                                        projectId: row.projectId,
                                        isBound: true,
                                        isAdmin: row.role === "admin",
                                      },
                                      "leave",
                                    ),
                                  destructive: true,
                                },
                                ...(row.role === "admin"
                                  ? [
                                      {
                                        label: "Delete study for everyone…",
                                        icon: "trash" as const,
                                        onSelect: () =>
                                          requestRemoveStudy(
                                            {
                                              title: row.title,
                                              path: row.path,
                                              projectId: row.projectId,
                                              isBound: true,
                                              isAdmin: true,
                                            },
                                            "delete_group",
                                          ),
                                        destructive: true,
                                      },
                                    ]
                                  : []),
                                {
                                  label: "Remove from list",
                                  icon: "close",
                                  onSelect: () => removeRecent(row.path),
                                },
                              ])
                            }
                            className="group flex items-center justify-between gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-3.5 transition-all hover:bg-[var(--fill)]"
                          >
                            <button
                              type="button"
                              onClick={() => handleOpenPath(row.path)}
                              disabled={loading}
                              className="flex min-w-0 flex-1 flex-col text-left disabled:opacity-50"
                            >
                              <div className="flex items-center gap-2">
                                <span className="truncate text-[14px] font-medium">
                                  {row.title}
                                </span>
                                {readiness.kind === "missing-transcripts" && (
                                  <span
                                    className="chip text-[10.5px]"
                                    style={{
                                      background: "var(--warning-soft, #fef3c7)",
                                      color: "var(--warning, #b45309)",
                                    }}
                                  >
                                    {readiness.missingCount} missing
                                  </span>
                                )}
                              </div>
                              <span className="hint mt-0.5 truncate text-[12px]">
                                you code as &ldquo;{row.coderName}&rdquo;
                                {membersText ? ` · ${membersText}` : ""}
                              </span>
                              <span
                                className="mt-1 truncate text-[11.5px]"
                                style={{ color: "var(--ink-3)" }}
                              >
                                {row.path}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => handleOpenPath(row.path)}
                              disabled={loading}
                              className="btn btn-outline btn-sm shrink-0"
                            >
                              Open
                            </button>
                          </div>
                        </li>
                      );
                    }

                    if (row.kind === "remote-group-unbound") {
                      const membersText = formatMembersPhrase(
                        row.members,
                        row.coderName,
                      );
                      return (
                        <li key={row.projectId}>
                          <div
                            onContextMenu={(e) =>
                              openContextMenu(e, [
                                {
                                  label: "Set up on this computer",
                                  icon: "folder",
                                  onSelect: () =>
                                    openJoinStudyForMembership({
                                      projectId: row.projectId,
                                      title: row.title,
                                      coderName: row.coderName,
                                      members: row.members,
                                      role: row.role,
                                    }),
                                  disabled: loading,
                                },
                                {
                                  label: "Leave study…",
                                  icon: "close",
                                  onSelect: () =>
                                    requestRemoveStudy(
                                      {
                                        title: row.title,
                                        projectId: row.projectId,
                                        isBound: true,
                                        isAdmin: row.role === "admin",
                                        isRemoteOnly: true,
                                      },
                                      "leave",
                                    ),
                                  destructive: true,
                                },
                              ])
                            }
                            className="flex items-center justify-between gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-3.5 transition-all"
                          >
                            <div className="flex min-w-0 flex-1 flex-col text-left">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-[14px] font-medium">
                                  {row.title}
                                </span>
                                <span className="chip text-[10.5px] opacity-75">
                                  Not on this computer
                                </span>
                              </div>
                              <span className="hint mt-0.5 truncate text-[12px]">
                                you code as &ldquo;{row.coderName}&rdquo;
                                {membersText ? ` · ${membersText}` : ""}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                openJoinStudyForMembership({
                                  projectId: row.projectId,
                                  title: row.title,
                                  coderName: row.coderName,
                                  members: row.members,
                                  role: row.role,
                                })
                              }
                              disabled={loading}
                              className="btn btn-primary btn-sm shrink-0"
                            >
                              Set up on this computer
                            </button>
                          </div>
                        </li>
                      );
                    }

                    // standalone-project
                    return (
                      <li key={row.path}>
                        <div
                          onContextMenu={(e) =>
                            openContextMenu(e, [
                              {
                                label: "Open study",
                                icon: "folder",
                                onSelect: () => handleOpenPath(row.path),
                                disabled: loading,
                              },
                              {
                                label: `Show in ${fileManagerName}`,
                                icon: "search",
                                onSelect: () => revealRecent(row.path),
                              },
                              {
                                label: "Copy path",
                                icon: "note",
                                onSelect: () => copyPath(row.path),
                              },
                              {
                                label: "Share this study…",
                                icon: "people",
                                onSelect: () => void handleShareProject(row.path),
                              },
                              {
                                label: "Delete study from this computer…",
                                icon: "trash",
                                onSelect: () =>
                                  requestRemoveStudy(
                                    {
                                      title: row.title,
                                      path: row.path,
                                      isBound: false,
                                      isAdmin: false,
                                    },
                                    "delete_solo",
                                  ),
                                destructive: true,
                              },
                              {
                                label: "Remove from list",
                                icon: "close",
                                onSelect: () => removeRecent(row.path),
                              },
                            ])
                          }
                          className="group flex items-center justify-between gap-3 rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-3.5 transition-all hover:bg-[var(--fill)]"
                        >
                          <button
                            type="button"
                            onClick={() => handleOpenPath(row.path)}
                            disabled={loading}
                            className="flex min-w-0 flex-1 flex-col text-left disabled:opacity-50"
                          >
                            <div className="flex items-center gap-2">
                              <span className="truncate text-[14px] font-medium">
                                {row.title}
                              </span>
                              <span className="chip text-[10.5px] opacity-75">
                                On this computer only
                              </span>
                            </div>
                            <span
                              className="mt-0.5 truncate text-[11.5px]"
                              style={{ color: "var(--ink-3)" }}
                            >
                              {basename(row.path)} · opened{" "}
                              {formatRelativeTime(row.lastOpenedAt)}
                            </span>
                            <span
                              className="mt-1 truncate text-[11.5px]"
                              style={{ color: "var(--ink-4)" }}
                            >
                              {row.path}
                            </span>
                          </button>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => void handleShareProject(row.path)}
                              disabled={loading}
                              className="btn btn-ghost btn-sm"
                            >
                              Share…
                            </button>
                            <button
                              type="button"
                              onClick={() => handleOpenPath(row.path)}
                              disabled={loading}
                              className="btn btn-outline btn-sm"
                            >
                              Open
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </div>
          )}

          {removalState && (
            <Modal
              open
              onClose={() => !actionBusy && setRemovalState(null)}
              title={
                removalState.mode === "delete_solo"
                  ? `Delete "${removalState.target.title}" from this computer?`
                  : removalState.target.isRemoteOnly
                    ? `Leave "${removalState.target.title}"?`
                    : `Remove study "${removalState.target.title}"`
              }
              subtitle={
                removalState.mode === "delete_solo"
                  ? `This moves the study folder to ${trashName()}.`
                  : removalState.target.isRemoteOnly
                    ? "Your account will be removed from the study roster on the server."
                    : "Choose how to remove or detach this study."
              }
              footer={
                <>
                  <button
                    type="button"
                    onClick={() => setRemovalState(null)}
                    className="btn btn-ghost"
                    disabled={actionBusy}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={confirmRemoval}
                    disabled={
                      actionBusy ||
                      (removalState.mode === "delete_group" &&
                        removalState.confirmTitleInput.trim() !==
                          removalState.target.title.trim())
                    }
                    className={`btn ${
                      removalState.mode === "detach"
                        ? "btn-outline"
                        : "btn-danger"
                    }`}
                  >
                    {actionBusy
                      ? "Processing…"
                      : removalState.mode === "delete_solo"
                        ? "Delete from this computer"
                        : removalState.mode === "detach"
                          ? "Remove from this Mac"
                          : removalState.mode === "leave"
                            ? removalState.alsoDeleteFolder
                              ? "Leave and delete folder"
                              : "Leave study"
                            : "Delete for everyone"}
                  </button>
                </>
              }
            >
              <div className="space-y-4 text-[13px]">
                {/* Solo delete view */}
                {removalState.mode === "delete_solo" && (
                  <div className="space-y-3">
                    {removalState.summary ? (
                      <div
                        className="rounded-lg p-3 text-[12.5px]"
                        style={{
                          background: "var(--fill)",
                          color: "var(--ink-2)",
                        }}
                      >
                        <p className="font-medium text-[var(--ink)]">
                          Contents:
                        </p>
                        <ul className="mt-1 list-disc pl-4 space-y-0.5">
                          <li>
                            {removalState.summary.interview_count} participants /
                            interviews
                          </li>
                          <li>
                            {removalState.summary.coded_segment_count} coded
                            passages
                          </li>
                          <li>
                            {removalState.summary.memo_count} memos
                          </li>
                        </ul>
                      </div>
                    ) : null}
                    <p
                      className="leading-relaxed"
                      style={{ color: "var(--ink-2)" }}
                    >
                      This moves the project folder and its database into your{" "}
                      {trashName()}. Transcripts stored in other folders are not
                      deleted.
                    </p>
                  </div>
                )}

                {/* Remote-only leave view */}
                {removalState.target.isRemoteOnly && (
                  <p
                    className="leading-relaxed"
                    style={{ color: "var(--ink-2)" }}
                  >
                    You will no longer be listed as a member of this study on the
                    server.
                  </p>
                )}

                {/* Bound study options */}
                {removalState.target.isBound &&
                  !removalState.target.isRemoteOnly && (
                    <div className="space-y-3">
                      {/* Option 1: Detach Local */}
                      <label
                        className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                          removalState.mode === "detach"
                            ? "border-[var(--accent)] bg-[var(--fill)]"
                            : "border-[var(--border)] hover:bg-[var(--fill)]"
                        }`}
                      >
                        <input
                          type="radio"
                          name="removal_mode"
                          checked={removalState.mode === "detach"}
                          onChange={() =>
                            setRemovalState((s) =>
                              s ? { ...s, mode: "detach" } : null,
                            )
                          }
                          className="mt-0.5"
                        />
                        <div className="flex-1">
                          <div className="font-medium text-[var(--ink)]">
                            Remove from this Mac
                          </div>
                          <div
                            className="mt-0.5 text-[12px] leading-relaxed"
                            style={{ color: "var(--ink-2)" }}
                          >
                            Stops syncing this study on this computer. Your
                            coding stays on the server and on your teammates'
                            machines; the folder is left in place.
                          </div>
                        </div>
                      </label>

                      {/* Option 2: Leave Study */}
                      <label
                        className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                          removalState.mode === "leave"
                            ? "border-[var(--danger,#ef4444)] bg-[var(--fill)]"
                            : "border-[var(--border)] hover:bg-[var(--fill)]"
                        }`}
                      >
                        <input
                          type="radio"
                          name="removal_mode"
                          checked={removalState.mode === "leave"}
                          onChange={() =>
                            setRemovalState((s) =>
                              s ? { ...s, mode: "leave" } : null,
                            )
                          }
                          className="mt-0.5"
                        />
                        <div className="flex-1">
                          <div className="font-medium text-[var(--ink)]">
                            Leave study
                          </div>
                          <div
                            className="mt-0.5 text-[12px] leading-relaxed"
                            style={{ color: "var(--ink-2)" }}
                          >
                            Removes your account from the study roster on the
                            server and stops syncing locally.
                          </div>

                          {removalState.mode === "leave" && (
                            <div className="mt-3 border-t border-[var(--border)] pt-2.5">
                              <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-medium text-[var(--ink)]">
                                <input
                                  type="checkbox"
                                  checked={removalState.alsoDeleteFolder}
                                  onChange={(e) =>
                                    setRemovalState((s) =>
                                      s
                                        ? {
                                            ...s,
                                            alsoDeleteFolder: e.target.checked,
                                          }
                                        : null,
                                    )
                                  }
                                />
                                Also delete the project folder from this computer
                              </label>
                              {removalState.alsoDeleteFolder && (
                                <p
                                  className="mt-1 text-[11.5px]"
                                  style={{ color: "var(--warning, #b45309)" }}
                                >
                                  ⚠️ This folder contains{" "}
                                  {removalState.summary?.memo_count ?? 0} local
                                  memos which are not saved on the server and will
                                  be permanently deleted.
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      </label>

                      {/* Option 3: Delete for everyone (Admin only) */}
                      {removalState.target.isAdmin && (
                        <label
                          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                            removalState.mode === "delete_group"
                              ? "border-[var(--danger,#ef4444)] bg-[var(--fill)]"
                              : "border-[var(--border)] hover:bg-[var(--fill)]"
                          }`}
                        >
                          <input
                            type="radio"
                            name="removal_mode"
                            checked={removalState.mode === "delete_group"}
                            onChange={() =>
                              setRemovalState((s) =>
                                s ? { ...s, mode: "delete_group" } : null,
                              )
                            }
                            className="mt-0.5"
                          />
                          <div className="flex-1">
                            <div className="flex items-center gap-2 font-medium text-[var(--danger,#ef4444)]">
                              Delete for everyone
                              <span className="chip text-[10px]">Admin only</span>
                            </div>
                            <div
                              className="mt-0.5 text-[12px] leading-relaxed"
                              style={{ color: "var(--ink-2)" }}
                            >
                              Deletes the entire study on the server for all
                              members. This cannot be undone.
                            </div>

                            {removalState.mode === "delete_group" && (
                              <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-2.5">
                                <label className="block text-[12px] text-[var(--ink-2)]">
                                  Type{" "}
                                  <strong className="text-[var(--ink)]">
                                    {removalState.target.title}
                                  </strong>{" "}
                                  to confirm:
                                </label>
                                <input
                                  type="text"
                                  value={removalState.confirmTitleInput}
                                  onChange={(e) =>
                                    setRemovalState((s) =>
                                      s
                                        ? {
                                            ...s,
                                            confirmTitleInput: e.target.value,
                                          }
                                        : null,
                                    )
                                  }
                                  placeholder={removalState.target.title}
                                  className="input input-sm w-full"
                                  autoFocus
                                />
                                <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-medium text-[var(--ink)]">
                                  <input
                                    type="checkbox"
                                    checked={removalState.alsoDeleteFolder}
                                    onChange={(e) =>
                                      setRemovalState((s) =>
                                        s
                                          ? {
                                              ...s,
                                              alsoDeleteFolder:
                                                e.target.checked,
                                            }
                                          : null,
                                      )
                                    }
                                  />
                                  Also delete the project folder from this
                                  computer
                                </label>
                                {removalState.alsoDeleteFolder && (
                                  <p
                                    className="mt-1 text-[11.5px]"
                                    style={{ color: "var(--warning, #b45309)" }}
                                  >
                                    ⚠️ This folder contains{" "}
                                    {removalState.summary?.memo_count ?? 0}{" "}
                                    local memos which will be deleted.
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        </label>
                      )}
                    </div>
                  )}
              </div>
            </Modal>
          )}

          <button
            type="button"
            onClick={() => openGuide("getting-started")}
            className="btn btn-ghost btn-sm mt-10"
          >
            <Icon name="book" size={14} />
            How coding works in Fleuron
          </button>
        </div>
      </div>
    </div>
  );
}

/** App mark: transcript lines resolving into a coded block. */
function Mark() {
  return (
    <div
      className="glass-card grid h-[72px] w-[72px] place-items-center"
      style={{ borderRadius: 20 }}
    >
      <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
        <rect x="6" y="7" width="15" height="3" rx="1.5" fill="var(--ink-3)" />
        <rect x="6" y="14" width="24" height="3" rx="1.5" fill="var(--accent)" />
        <rect x="6" y="21" width="19" height="3" rx="1.5" fill="var(--ink-3)" />
        <rect x="6" y="28" width="11" height="3" rx="1.5" fill="var(--ink-4)" />
      </svg>
    </div>
  );
}

function HomeCard({
  icon,
  title,
  subtitle,
  onClick,
  disabled,
  primary,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  onClick: () => void;
  disabled?: boolean;
  /** The one a first-time visitor most likely wants, in the accent colour. */
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="glass-card flex items-center gap-3.5 p-4 text-left transition-transform active:scale-[0.985] disabled:opacity-50"
    >
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full"
        style={
          primary
            ? { background: "var(--accent)", color: "var(--accent-ink)" }
            : { background: "var(--fill-hi)", color: "var(--ink-2)" }
        }
      >
        <Icon name={icon} size={19} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium">{title}</span>
        <span className="hint mt-0.5 block">{subtitle}</span>
      </span>
      <Icon name="arrowRight" size={16} className="opacity-40" />
    </button>
  );
}
