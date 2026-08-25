import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { Icon } from "./ui/Icon";
import { useSyncStore } from "../store/sync-store";
import { useAppStore } from "../store/app-store";

/**
 * Sync state in the toolbar, and the only entry point to the sync sheet.
 *
 * Renders nothing at all until sync is configured on this machine, so the
 * feature is invisible to anyone who has not set it up rather than being a
 * permanently greyed-out control.
 */
export function SyncChip() {
  const { status, syncing, error } = useSyncStore(
    useShallow((s) => ({
      status: s.status,
      syncing: s.syncing,
      error: s.error,
    })),
  );
  const refreshStatus = useSyncStore((s) => s.refreshStatus);
  const openSyncSheet = useSyncStore((s) => s.openSyncSheet);
  const openSettings = useAppStore((s) => s.openSettings);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const signedIn = status?.signedIn ?? false;
  const inGroup = status?.inGroup ?? false;

  const pending = status?.pendingChanges ?? 0;
  const protocolV2 = status?.protocol === 2;
  const blocked = status?.blockedOutboxCount ?? 0;
  const conflicts = status?.unresolvedConflictCount ?? 0;
  const oldestQueued = status?.oldestOutboxAgeSeconds ?? 0;
  const lagAge = status?.sequenceLagAgeSeconds ?? 0;
  const durableLag = Math.max(
    0,
    (status?.observedHead ?? 0) - (status?.localSequence ?? 0),
  );
  const coordinatorActive =
    status?.coordinatorRunning || status?.coordinatorRerunRequested;
  const needsAttention =
    protocolV2 &&
    (blocked > 0 || oldestQueued > 60 || (durableLag > 0 && lagAge > 30));

  if (!status?.configured) return null;
  let label: string;
  let tone = "chip";

  if (syncing || coordinatorActive) {
    label = "Syncing…";
  } else if (!signedIn) {
    label = "Sign in to sync";
    tone = "chip chip-warn";
  } else if (!inGroup) {
    label = "Not in a group";
    tone = "chip chip-warn";
  } else if (needsAttention) {
    label = blocked > 0
      ? "Attention—blocked changes"
      : durableLag > 0 && lagAge > 30
        ? "Attention—sync lag"
        : "Attention—queued changes";
    tone = "chip chip-warn";
  } else if (error) {
    label = protocolV2 && pending > 0
      ? "Offline—changes safe here"
      : "Sync failed";
    tone = "chip chip-warn";
  } else if (status?.neverSynced) {
    label = "Never synced on this computer";
    tone = "chip chip-warn";
  } else if (pending > 0) {
    label = `${pending} to send`;
  } else if (!protocolV2 || durableLag === 0) {
    label = "Synced";
    tone = "chip chip-ok";
  } else {
    label = "Syncing…";
  }

  if (conflicts > 0) {
    label = `${label} · ${conflicts} conflict${conflicts === 1 ? "" : "s"}`;
    tone = "chip chip-warn";
  }

  return (
    <button
      type="button"
      className={tone}
      onClick={() => {
        if (!signedIn) openSettings();
        else openSyncSheet();
      }}
      title={
        !signedIn
          ? "Sign in to exchange coding with your group"
          : !inGroup
            ? "Start a group or join one with a key"
            : "Coding decisions sync across the group. Transcripts and memos stay on this machine."
      }
    >
      <Icon name={syncing ? "clock" : "people"} size={12} />
      {label}
    </button>
  );
}
