import { useShallow } from "zustand/react/shallow";
import { formatBytes, formatRelativeTime } from "../lib/format";
import type { UpdateCoordinatorStatus } from "../lib/types";
import { useUpdateStore } from "../store/update-store";
import { Icon } from "./ui/Icon";

export interface UpdateActionCopy {
  label: string;
  title: string;
  disabled: boolean;
  spinning: boolean;
}

/**
 * Keep updater copy derived from the coordinator state in one place. The
 * primary action always moves through the native state machine; React never
 * decides that it is safe to relaunch or install an update itself.
 */
export function describeUpdateAction(
  status: UpdateCoordinatorStatus | null,
): UpdateActionCopy {
  if (!status || status.phase === "idle") {
    return {
      label: "Check for updates",
      title: "Check for updates",
      disabled: false,
      spinning: false,
    };
  }

  switch (status.phase) {
    case "checking":
      return {
        label: "Checking…",
        title: "Checking for updates",
        disabled: true,
        spinning: true,
      };
    case "available":
      return {
        label: "Update available",
        title: status.targetVersion
          ? `Download Codemap ${status.targetVersion}`
          : "Download available update",
        disabled: false,
        spinning: false,
      };
    case "downloading": {
      const percent = status.totalBytes && status.totalBytes > 0
        ? Math.min(100, Math.round((status.downloadedBytes / status.totalBytes) * 100))
        : null;
      return {
        label: percent === null ? "Downloading…" : `Downloading ${percent}%`,
        title: "Cancel update download",
        disabled: false,
        spinning: true,
      };
    }
    case "readyToInstall":
      return {
        label: "Ready—restart to update",
        title: "Restart Codemap to install the verified update",
        disabled: false,
        spinning: false,
      };
    case "preparing":
      return {
        label: status.syncPreflightOutcome === null
          ? "Saving changes before update…"
          : "Preparing update…",
        title: "Preparing the verified update",
        disabled: true,
        spinning: true,
      };
    case "installing":
      return {
        label: "Installing…",
        title: "Installing the verified update",
        disabled: true,
        spinning: true,
      };
    case "failed":
      return {
        label: "Update failed—retry",
        title: status.failure?.message || "Retry update",
        disabled: false,
        spinning: false,
      };
  }
}

interface UpdateActionProps {
  /** Keep an icon affordance in narrow top chrome while hiding only its text. */
  compact?: boolean;
  className?: string;
}

export function UpdateAction({ compact = false, className = "" }: UpdateActionProps) {
  const { status, runPrimaryAction } = useUpdateStore(
    useShallow((state) => ({
      status: state.status,
      runPrimaryAction: state.runPrimaryAction,
    })),
  );
  const copy = describeUpdateAction(status);

  return (
    <button
      type="button"
      data-testid="update-action"
      onClick={() => void runPrimaryAction()}
      disabled={copy.disabled}
      className={`btn btn-ghost btn-sm gap-1.5 ${className}`}
      aria-label={`Update: ${copy.label}`}
      title={copy.title}
    >
      <span className="relative inline-flex">
        <Icon name="refresh" size={14} className={copy.spinning ? "animate-spin" : ""} />
        {status?.phase === "available" || status?.phase === "readyToInstall" || status?.phase === "failed" ? (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--accent)" }}
          />
        ) : null}
      </span>
      <span className={compact ? "hidden min-[1280px]:inline" : "inline"}>
        {copy.label}
      </span>
    </button>
  );
}

/** Full updater detail for Settings, where version/recovery context matters. */
export function UpdateStatus() {
  const { status, runPrimaryAction } = useUpdateStore(
    useShallow((state) => ({
      status: state.status,
      runPrimaryAction: state.runPrimaryAction,
    })),
  );
  const copy = describeUpdateAction(status);
  const progress = status?.phase === "downloading" && status.totalBytes
    ? `${formatBytes(status.downloadedBytes)} of ${formatBytes(status.totalBytes)}`
    : null;

  return (
    <section aria-labelledby="updates-heading">
      <h3 id="updates-heading" className="eyebrow">Updates</h3>
      <div
        className="mt-3 rounded-[var(--r-md)] border p-3"
        style={{ borderColor: "var(--border)", background: "var(--fill)" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[13px] font-medium">
              Current version {status?.currentVersion ? `v${status.currentVersion}` : "unknown"}
            </p>
            <p className="hint mt-0.5">
              {status?.lastCheckedAt
                ? `Last checked ${formatRelativeTime(status.lastCheckedAt)}`
                : "Not checked in this session"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runPrimaryAction()}
            disabled={copy.disabled}
            className="btn btn-outline btn-sm shrink-0"
            aria-label={`Update: ${copy.label}`}
            title={copy.title}
          >
            <Icon name="refresh" size={13} className={copy.spinning ? "animate-spin" : ""} />
            {copy.label}
          </button>
        </div>
        {status?.targetVersion ? (
          <p className="hint mt-2">Target version v{status.targetVersion}</p>
        ) : null}
        {progress ? <p className="hint mt-1">{progress}</p> : null}
        {status?.phase === "preparing" ? (
          <p className="hint mt-1">
            {status.syncPreflightOutcome === null
              ? "Saving changes before update…"
              : "Your durable local changes are safe during restart."}
          </p>
        ) : null}
        {status?.failure ? (
          <p role="status" className="mt-2 text-[12px]" style={{ color: "var(--danger)" }}>
            {status.failure.message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/** Blocks mutations only during native hand-off; navigation stays visible behind it. */
export function UpdatePreparationOverlay() {
  const status = useUpdateStore((state) => state.status);
  if (status?.phase !== "preparing" && status?.phase !== "installing") return null;

  const saving = status.phase === "preparing" && status.syncPreflightOutcome === null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/10 p-5 sm:items-center"
      role="status"
      aria-live="assertive"
      aria-label="Preparing update"
    >
      <div
        className="max-w-sm rounded-[var(--r-lg)] border px-4 py-3 shadow-[var(--shadow-2)]"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-2.5">
          <Icon name="refresh" size={16} className="animate-spin" />
          <div>
            <p className="text-[13px] font-medium">Preparing update—your work is saved</p>
            <p className="hint mt-0.5">
              {saving ? "Saving changes before update…" : "Finishing the safe hand-off to the installer…"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
