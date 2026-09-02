/**
 * Frontend half of the stable file-failure contract.
 *
 * The Rust command boundary wraps classifyable failures as
 *   CODEMAP_FILE_ERROR|{"category":"…","message":"…","detail":"…"}
 * This module is the ONLY place that sentinel is parsed. Components receive a
 * FileAccessUi object with copy and actions; the technical `detail` string
 * stays available for an expandable "details" disclosure but never renders in
 * primary UI. Legacy plain-string errors pass through untouched so old call
 * sites keep working.
 */

export type FileAccessCategory =
  | "permission_denied"
  | "path_unavailable"
  | "storage_full"
  | "read_only_storage"
  | "file_in_use"
  | "name_in_use"
  | "content_not_downloaded"
  | "invalid_project";

const SENTINEL = "CODEMAP_FILE_ERROR|";

export interface FileAccessUi {
  category: FileAccessCategory;
  /** Primary, non-technical explanation. Safe to render anywhere. */
  message: string;
  /** Technical detail for optional diagnostics disclosure. Never primary UI. */
  detail: string;
}

export function parseFileError(raw: unknown): FileAccessUi | null {
  if (typeof raw !== "string" || !raw.startsWith(SENTINEL)) return null;
  try {
    const parsed = JSON.parse(raw.slice(SENTINEL.length)) as {
      category?: string;
      message?: string;
      detail?: string;
    };
    if (!parsed.category) return null;
    return {
      category: parsed.category as FileAccessCategory,
      message: parsed.message ?? defaultCopy(parsed.category as FileAccessCategory).message,
      detail: parsed.detail ?? "",
    };
  } catch {
    return null;
  }
}

const COPY: Record<FileAccessCategory, { message: string; recovery: string }> = {
  permission_denied: {
    message: "Fleuron does not have permission to use that location.",
    recovery:
      "Choose another folder, or grant access when your system asks again. On macOS you can revisit this under System Settings → Privacy & Security → Files and Folders.",
  },
  path_unavailable: {
    message: "That folder isn't reachable right now.",
    recovery:
      "It may have been moved, renamed, or disconnected — like an unplugged drive or an offline cloud folder. Use Locate folder to point Fleuron at its new place.",
  },
  storage_full: {
    message: "There isn't enough space to complete that.",
    recovery: "Free up disk space, then try again, or choose a location with more room.",
  },
  read_only_storage: {
    message: "That location can't be written to.",
    recovery:
      "The disk may be full, write-protected, or mounted read-only. Choose another location instead.",
  },
  file_in_use: {
    message: "Something else is using that file right now.",
    recovery: "Close it in the other app, wait a moment, and try again.",
  },
  name_in_use: {
    message: "A folder with that name is already here.",
    recovery:
      "Fleuron can use the existing folder or make a new one — see the options above.",
  },
  content_not_downloaded: {
    message: "This study's files haven't downloaded from cloud storage yet.",
    recovery:
      "Box, iCloud, or OneDrive may still be syncing or offline. Wait for download to finish or mark the folder 'Always keep on this device'.",
  },
  invalid_project: {
    message: "This study could not be opened.",
    recovery:
      "The study folder may be incomplete or damaged. If you have a backup of this study, restore it from the Backups panel.",
  },
};

function defaultCopy(category: FileAccessCategory) {
  return COPY[category] ?? COPY.invalid_project;
}

/** Stable category → user-facing copy + safe next actions. */
export function fileAccessCopy(ui: FileAccessUi): {
  title: string;
  recovery: string;
} {
  return {
    title: ui.message || defaultCopy(ui.category).message,
    recovery: defaultCopy(ui.category).recovery,
  };
}

/** Which inline actions make sense per category. */
export function recoveryActions(
  category: FileAccessCategory,
): ("locate-folder" | "choose-another" | "retry" | "remove-recent")[] {
  switch (category) {
    case "path_unavailable":
      return ["locate-folder", "choose-another", "remove-recent"];
    case "permission_denied":
      return ["choose-another", "retry"];
    case "file_in_use":
      return ["retry", "choose-another"];
    default:
      return ["choose-another", "retry"];
  }
}
