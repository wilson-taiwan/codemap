//! Stable, classifiable file-access failures at the command boundary.
//!
//! Why this exists: raw OS strings (`os error 5`, Win32 codes, SQLite texts)
//! are unreadable and frightening after an install warning — and they leak
//! paths into UI. Frontend recovery UI needs only *which category* failed so
//! it can offer Locate folder / Choose another folder / How to fix access
//! without rendering internals.
//!
//! Wire format for classified errors is one line:
//!   CODEMAP_FILE_ERROR|{"category":"permission_denied","message":"…","detail":"…"}
//! Anything not carrying that sentinel is a legacy string and renders as
//! before. The `detail` field never goes into primary UI copy.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileAccessCategory {
    PermissionDenied,
    PathUnavailable,
    StorageFull,
    ReadOnlyStorage,
    FileInUse,
    NameInUse,
    ContentNotDownloaded,
    InvalidProject,
}

impl FileAccessCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            FileAccessCategory::PermissionDenied => "permission_denied",
            FileAccessCategory::PathUnavailable => "path_unavailable",
            FileAccessCategory::StorageFull => "storage_full",
            FileAccessCategory::ReadOnlyStorage => "read_only_storage",
            FileAccessCategory::FileInUse => "file_in_use",
            FileAccessCategory::NameInUse => "name_in_use",
            FileAccessCategory::ContentNotDownloaded => "content_not_downloaded",
            FileAccessCategory::InvalidProject => "invalid_project",
        }
    }
}

/// Classify an `std::io::Error` by kind first, then OS code — kinds cover most
/// of the surface on both platforms; raw codes catch errno-shaped strays that
/// arrive flattened into strings by mid-layers.
pub fn classify_io(err: &std::io::Error) -> FileAccessCategory {
    match err.kind() {
        std::io::ErrorKind::PermissionDenied => return FileAccessCategory::PermissionDenied,
        std::io::ErrorKind::NotFound => return FileAccessCategory::PathUnavailable,
        std::io::ErrorKind::StorageFull => return FileAccessCategory::StorageFull,
        std::io::ErrorKind::ReadOnlyFilesystem => return FileAccessCategory::ReadOnlyStorage,
        _ => {}
    }
    classify_message(&err.to_string())
}

/// Best-effort classification of an arbitrary error string (io errors passed
/// through `.to_string()`, rusqlite texts, Windows API texts).
pub fn classify_message(raw: &str) -> FileAccessCategory {
    let lower = raw.to_lowercase();
    const TABLE: [(&str, FileAccessCategory); 13] = [
        ("access is denied", FileAccessCategory::PermissionDenied),
        ("permission denied", FileAccessCategory::PermissionDenied),
        (
            "operation not permitted",
            FileAccessCategory::PermissionDenied,
        ),
        ("not found", FileAccessCategory::PathUnavailable),
        ("no such file", FileAccessCategory::PathUnavailable),
        ("cannot find the path", FileAccessCategory::PathUnavailable),
        ("not enough space", FileAccessCategory::StorageFull),
        ("used by another process", FileAccessCategory::FileInUse),
        ("being used by another", FileAccessCategory::FileInUse),
        (
            "project folder already exists",
            FileAccessCategory::NameInUse,
        ),
        ("folder already exists", FileAccessCategory::NameInUse),
        ("already exists", FileAccessCategory::NameInUse),
        ("file exists", FileAccessCategory::NameInUse),
    ];
    for (needle, category) in TABLE {
        if lower.contains(needle) {
            return category;
        }
    }
    // Eviction signatures (iCloud / Box / OneDrive placeholder)
    if lower.contains("etimedout")
        || lower.contains("os error 60")
        || lower.contains("operation timed out")
        || lower.contains("mmap failed")
    {
        return FileAccessCategory::ContentNotDownloaded;
    }
    // Windows read-only media surfaces as os error 19; macOS EROFS as 30.
    if lower.contains("os error 19") || lower.contains("os error 30") {
        return FileAccessCategory::ReadOnlyStorage;
    }
    // in-use often arrives as os error 32 (Windows) / 16 (mac EBUSY)
    if lower.contains("os error 32") || lower.contains("os error 16") {
        return FileAccessCategory::FileInUse;
    }
    FileAccessCategory::InvalidProject
}

#[derive(Serialize)]
struct ClassifiedFileError<'a> {
    category: &'a str,
    message: &'a str,
    detail: &'a str,
}

const SENTINEL: &str = "CODEMAP_FILE_ERROR|";

/// Wrap a classification + user-safe message + technical detail into the wire
/// payload understood by `src/lib/file-access.ts`.
pub fn wrap_file_error(category: FileAccessCategory, message: &str, detail: &str) -> String {
    let payload = ClassifiedFileError {
        category: category.as_str(),
        message,
        detail,
    };
    format!(
        "{SENTINEL}{}",
        serde_json::to_string(&payload).unwrap_or_else(|_| format!(
            "{SENTINEL}{{\"category\":\"invalid_project\",\"message\":\"This study could not be opened.\",\"detail\":\"serialization\"}}"
        ))
    )
}

/// Convenience used at command boundaries: classify any stringly error and
/// produce the frontend payload with the given user-safe message.
pub fn classified(message: &str, raw_error: &str) -> String {
    wrap_file_error(classify_message(raw_error), message, raw_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_kinds_map_to_stable_categories() {
        assert_eq!(
            classify_io(&std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
            FileAccessCategory::PermissionDenied
        );
        assert_eq!(
            classify_io(&std::io::Error::from(std::io::ErrorKind::NotFound)),
            FileAccessCategory::PathUnavailable
        );
        assert_eq!(
            classify_io(&std::io::Error::from(std::io::ErrorKind::StorageFull)),
            FileAccessCategory::StorageFull
        );
    }

    #[test]
    fn platform_message_shapes_map_correctly() {
        // Windows denial
        assert_eq!(
            classify_message("Access is denied. (os error 5)"),
            FileAccessCategory::PermissionDenied
        );
        // macOS TCC-era denial wording
        assert_eq!(
            classify_message("Operation not permitted (os error 1)"),
            FileAccessCategory::PermissionDenied
        );
        // Windows in-use
        assert_eq!(
            classify_message(
                "The process cannot access the file because it is being used by another process. (os error 32)"
            ),
            FileAccessCategory::FileInUse
        );
        // Read-only volume variants
        assert_eq!(
            classify_message("Read-only file system (os error 30)"),
            FileAccessCategory::ReadOnlyStorage
        );
        assert_eq!(
            classify_message("The media is write protected. (os error 19)"),
            FileAccessCategory::ReadOnlyStorage
        );
        // Folder exists / Name in use (Task 3)
        assert_eq!(
            classify_message("Invalid parameter name: Project folder already exists"),
            FileAccessCategory::NameInUse
        );
        assert_eq!(
            classify_message("destination path already exists"),
            FileAccessCategory::NameInUse
        );
        // Eviction / Content not downloaded (Task 9)
        assert_eq!(
            classify_message("Operation timed out (os error 60)"),
            FileAccessCategory::ContentNotDownloaded
        );
        assert_eq!(
            classify_message("resource temporarily unavailable: etimedout"),
            FileAccessCategory::ContentNotDownloaded
        );
        assert_eq!(
            classify_message("mmap failed: resource temporarily unavailable"),
            FileAccessCategory::ContentNotDownloaded
        );
        // Unknown falls back to invalid_project, never to a panic
        assert_eq!(
            classify_message("something unprecedented"),
            FileAccessCategory::InvalidProject
        );
    }

    #[test]
    fn wrapped_payload_round_trips_through_frontend_shape() {
        let wrapped = wrap_file_error(
            FileAccessCategory::PermissionDenied,
            "Fleuron does not have permission to open this folder.",
            "/Users/x/secret (os error 5)",
        );
        assert!(wrapped.starts_with("CODEMAP_FILE_ERROR|"));
        let json = wrapped.strip_prefix(SENTINEL).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(parsed["category"], "permission_denied");
        assert!(!parsed["message"].as_str().unwrap().contains("/Users"));
        assert!(parsed["detail"].as_str().unwrap().contains("os error 5"));
    }

    #[test]
    fn classified_keeps_detail_out_of_message() {
        let wrapped = classified(
            "Could not scan that folder.",
            "SQLite whatever /Users/you/stuff",
        );
        assert!(wrapped.starts_with("CODEMAP_FILE_ERROR|"));
        assert!(wrapped.contains("\"detail\""));
    }
}
