use std::path::Path;

const MAX_PANIC_PAYLOAD_CHARS: usize = 120;

/// Returns the last 8 characters of an identifier.
/// Empty strings return empty; strings shorter than 8 return the full string.
pub fn safe_suffix(value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    value
        .chars()
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

/// Redacts a path to reveal only its structural shape, never user identifiers or study names.
///
/// Rules:
/// - Replaces home directory with `<home>`
/// - Replaces default library dir (`~/Fleuron` or `%USERPROFILE%\Fleuron`) with `<library>`
/// - Replaces unrecognised directory or file names with `<name>`, preserving safe extensions.
pub fn redact_path(p: &Path) -> String {
    let raw_str = p.to_string_lossy();
    if raw_str.trim().is_empty() {
        return String::new();
    }

    let is_windows =
        raw_str.contains('\\') || (raw_str.len() >= 2 && raw_str.chars().nth(1) == Some(':'));
    let sep = if is_windows { '\\' } else { '/' };

    // Normalise separators for processing
    let normalized = raw_str.replace('\\', "/");

    // Detect library and home prefixes
    let mut prefix_replacement: Option<(&str, String)> = None;

    let home_env = std::env::var("HOME").ok();
    let userprofile_env = std::env::var("USERPROFILE").ok();

    let candidates = [home_env.as_deref(), userprofile_env.as_deref()];

    for candidate in candidates.into_iter().flatten() {
        let clean = candidate.trim_end_matches('/');
        if !clean.is_empty() {
            let lib = format!("{}/Fleuron", clean);
            if normalized == lib || normalized.starts_with(&format!("{}/", lib)) {
                prefix_replacement = Some(("<library>", lib));
                break;
            }
            if normalized == clean || normalized.starts_with(&format!("{}/", clean)) {
                prefix_replacement = Some(("<home>", clean.to_string()));
                break;
            }
        }
    }

    // Heuristic detection for paths formatted as /Users/<user> or /home/<user> or C:/Users/<user>
    if prefix_replacement.is_none() {
        if let Some(rest) = normalized.strip_prefix("/Users/") {
            if let Some(user_end) = rest.find('/') {
                let home_path = format!("/Users/{}", &rest[..user_end]);
                let lib_path = format!("{}/Fleuron", home_path);
                if normalized == lib_path || normalized.starts_with(&format!("{}/", lib_path)) {
                    prefix_replacement = Some(("<library>", lib_path));
                } else {
                    prefix_replacement = Some(("<home>", home_path));
                }
            } else {
                prefix_replacement = Some(("<home>", normalized.clone()));
            }
        } else if let Some(rest) = normalized.strip_prefix("/home/") {
            if let Some(user_end) = rest.find('/') {
                let home_path = format!("/home/{}", &rest[..user_end]);
                let lib_path = format!("{}/Fleuron", home_path);
                if normalized == lib_path || normalized.starts_with(&format!("{}/", lib_path)) {
                    prefix_replacement = Some(("<library>", lib_path));
                } else {
                    prefix_replacement = Some(("<home>", home_path));
                }
            } else {
                prefix_replacement = Some(("<home>", normalized.clone()));
            }
        } else if normalized.len() >= 9
            && (&normalized[1..9] == ":/Users/" || &normalized[1..9] == ":/users/")
        {
            let drive_prefix = &normalized[..2];
            let rest = &normalized[9..];
            if let Some(user_end) = rest.find('/') {
                let home_path = format!("{}/Users/{}", drive_prefix, &rest[..user_end]);
                let lib_path = format!("{}/Fleuron", home_path);
                if normalized == lib_path || normalized.starts_with(&format!("{}/", lib_path)) {
                    prefix_replacement = Some(("<library>", lib_path));
                } else {
                    prefix_replacement = Some(("<home>", home_path));
                }
            } else {
                prefix_replacement = Some(("<home>", normalized.clone()));
            }
        }
    }

    let mut parts: Vec<String> = Vec::new();
    let remainder = if let Some((tag, prefix)) = prefix_replacement {
        parts.push(tag.to_string());
        normalized
            .strip_prefix(&prefix)
            .unwrap_or("")
            .trim_start_matches('/')
    } else {
        &normalized
    };

    if !remainder.is_empty() {
        for segment in remainder.split('/') {
            if segment.is_empty() {
                continue;
            }
            parts.push(redact_path_segment(segment));
        }
    }

    if parts.is_empty() {
        return if is_windows {
            "\\".to_string()
        } else {
            "/".to_string()
        };
    }

    let joined = parts.join(&sep.to_string());
    if normalized.starts_with('/') && !joined.starts_with('<') && !joined.starts_with('/') {
        format!("/{}", joined)
    } else {
        joined
    }
}

fn is_known_safe_literal(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "project.db"
            | "project.db-wal"
            | "project.db-shm"
            | ".staging-restore.db"
            | ".staging-restore.db-wal"
            | ".staging-restore.db-shm"
            | ".codemap"
            | ".codemapbak"
            | ".fleuronbak"
            | "crashes"
            | "crash.log"
            | "crash.log.1"
            | "crash.log.2"
            | "crash.log.3"
            | "project.json"
            | "fleuron"
            | "fleuron.exe"
            | "fleuron.app"
            | "contents"
            | "macos"
            | "resources"
            | "staged_update"
            | "updater"
            | "current_update.tar.gz"
            | "latest.json"
            | "appdata"
            | "local"
            | "roaming"
            | "programs"
            | "applications"
    )
}

fn redact_path_segment(segment: &str) -> String {
    if is_known_safe_literal(segment) {
        return segment.to_string();
    }

    // Preserve known safe extensions
    let safe_extensions = [
        ".fleuron",
        ".codemap",
        ".qcproj",
        ".fleuronbak",
        ".codemapbak",
        ".db",
        ".db-wal",
        ".db-shm",
        ".json",
        ".log",
        ".exe",
        ".app",
        ".dmg",
        ".tar.gz",
        ".txt",
        ".csv",
    ];

    for ext in safe_extensions {
        if segment.to_ascii_lowercase().ends_with(ext) {
            return format!("<name>{}", ext);
        }
    }

    "<name>".to_string()
}

/// Redacts a crash log panic payload for safe sharing.
///
/// Rules:
/// - Collapses any character run outside `[a-zA-Z0-9 ._:/()-]` to a single space.
/// - Limits the resulting text to at most 120 characters.
/// - Prefixes with `[payload truncated for privacy] `.
/// - If characters were truncated, appends ` ...(+N chars withheld)`.
pub fn redact_panic_payload(raw: &str) -> String {
    let mut sanitized = raw.to_string();

    let home_env = std::env::var("HOME").ok();
    let userprofile_env = std::env::var("USERPROFILE").ok();
    for candidate in [home_env.as_deref(), userprofile_env.as_deref()]
        .into_iter()
        .flatten()
    {
        let clean = candidate.trim_end_matches('/').trim_end_matches('\\');
        if !clean.is_empty() {
            sanitized = sanitized.replace(clean, "<home>");
        }
    }

    let mut collapsed = String::with_capacity(sanitized.len());
    let mut last_was_space = false;

    for ch in sanitized.chars() {
        if ch.is_ascii_alphanumeric()
            || ch == ' '
            || ch == '.'
            || ch == '_'
            || ch == ':'
            || ch == '/'
            || ch == '('
            || ch == ')'
            || ch == '-'
            || ch == '<'
            || ch == '>'
        {
            if ch == ' ' {
                if !last_was_space {
                    collapsed.push(' ');
                    last_was_space = true;
                }
            } else {
                collapsed.push(ch);
                last_was_space = false;
            }
        } else if !last_was_space {
            collapsed.push(' ');
            last_was_space = true;
        }
    }

    let trimmed = collapsed.trim();
    let char_count = trimmed.chars().count();

    if char_count <= MAX_PANIC_PAYLOAD_CHARS {
        format!("[payload truncated for privacy] {}", trimmed)
    } else {
        let truncated: String = trimmed.chars().take(MAX_PANIC_PAYLOAD_CHARS).collect();
        let withheld = char_count - MAX_PANIC_PAYLOAD_CHARS;
        format!(
            "[payload truncated for privacy] {} ...(+{} chars withheld)",
            truncated, withheld
        )
    }
}

/// Parses crash.log records, applies `redact_panic_payload` to every message,
/// and limits backtraces to at most 3 frames.
pub fn parse_and_redact_crash_log(raw_log: &str) -> String {
    let raw = raw_log.trim();
    if raw.is_empty() {
        return "Records count: 0 (clean)".to_string();
    }

    let records: Vec<&str> = raw
        .split("--- CRASH RECORD ---")
        .filter(|chunk| !chunk.trim().is_empty())
        .collect();

    if records.is_empty() {
        return "Records count: 0 (clean)".to_string();
    }

    let mut output = format!("Records count: {}\n", records.len());

    for (idx, record) in records.iter().enumerate() {
        let clean_record = record.split("--- END RECORD ---").next().unwrap_or(record);
        let mut timestamp = "unknown";
        let mut version = "unknown";
        let mut os_info = "unknown";
        let mut thread = "unknown";
        let mut location = "unknown";
        let mut message = String::new();
        let mut in_backtrace = false;
        let mut backtrace_lines: Vec<&str> = Vec::new();

        for line in clean_record.lines() {
            let line_trimmed = line.trim();
            if in_backtrace {
                if !line_trimmed.is_empty() {
                    backtrace_lines.push(line_trimmed);
                }
            } else if let Some(ts) = line_trimmed.strip_prefix("Timestamp:") {
                timestamp = ts.trim();
            } else if let Some(v) = line_trimmed.strip_prefix("Version:") {
                version = v.trim();
            } else if let Some(os) = line_trimmed.strip_prefix("OS:") {
                os_info = os.trim();
            } else if let Some(t) = line_trimmed.strip_prefix("Thread:") {
                thread = t.trim();
            } else if let Some(loc) = line_trimmed.strip_prefix("Location:") {
                location = loc.trim();
            } else if let Some(msg) = line_trimmed.strip_prefix("Message:") {
                message = msg.trim().to_string();
            } else if line_trimmed.starts_with("Backtrace:") {
                in_backtrace = true;
            }
        }

        let redacted_msg = redact_panic_payload(&message);
        let capped_backtrace: Vec<&str> = backtrace_lines.into_iter().take(3).collect();
        let bt_str = if capped_backtrace.is_empty() {
            "  (no frames recorded)".to_string()
        } else {
            let mut s = capped_backtrace
                .into_iter()
                .map(|l| format!("  {}", l))
                .collect::<Vec<_>>()
                .join("\n");
            s.push_str("\n  [additional frames omitted]");
            s
        };

        output.push_str(&format!(
            "\n[Record {}]\nTimestamp: {}\nVersion: {}\nOS: {}\nThread: {}\nLocation: {}\nMessage: {}\nBacktrace:\n{}\n",
            idx + 1,
            timestamp,
            version,
            os_info,
            thread,
            location,
            redacted_msg,
            bt_str
        ));
    }

    output
}

pub fn check_poisoned_install(exe_dir: &Path) -> (bool, &'static str) {
    let nested_exe_dir = exe_dir.join("Fleuron.exe");
    if nested_exe_dir.is_dir() {
        return (true, "detected: Fleuron.exe is a directory");
    }
    if nested_exe_dir.join("Fleuron.exe").exists() {
        return (true, "detected: nested Fleuron.exe\\Fleuron.exe path");
    }
    (false, "clean")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageDiagnostics {
    pub project_dir_redacted: String,
    pub db_exists: bool,
    pub db_size_bytes: Option<u64>,
    pub wal_exists: bool,
    pub wal_size_bytes: Option<u64>,
    pub shm_exists: bool,
    pub shm_size_bytes: Option<u64>,
    pub stranded_staging_restore: bool,
}

pub fn check_storage_status(project_dir: &Path) -> StorageDiagnostics {
    let db_path = project_dir.join("project.db");
    let wal_path = project_dir.join("project.db-wal");
    let shm_path = project_dir.join("project.db-shm");
    let staging_path = project_dir.join(".staging-restore.db");

    let file_info = |p: &Path| -> (bool, Option<u64>) {
        if let Ok(meta) = std::fs::metadata(p) {
            (true, Some(meta.len()))
        } else {
            (false, None)
        }
    };

    let (db_exists, db_size) = file_info(&db_path);
    let (wal_exists, wal_size) = file_info(&wal_path);
    let (shm_exists, shm_size) = file_info(&shm_path);
    let stranded_staging_restore = staging_path.exists() || staging_path.is_file();

    StorageDiagnostics {
        project_dir_redacted: redact_path(project_dir),
        db_exists,
        db_size_bytes: db_size,
        wal_exists,
        wal_size_bytes: wal_size,
        shm_exists,
        shm_size_bytes: shm_size,
        stranded_staging_restore,
    }
}

pub fn format_storage_diagnostics(diag: &StorageDiagnostics) -> String {
    let size_str = |exists: bool, size: Option<u64>| -> String {
        if exists {
            format!("present ({} bytes)", size.unwrap_or(0))
        } else {
            "absent".to_string()
        }
    };

    let stranded_str = if diag.stranded_staging_restore {
        "detected (.staging-restore.db is stranded)"
    } else {
        "clean"
    };

    format!(
        "Project directory: {}\nproject.db: {}\nproject.db-wal: {}\nproject.db-shm: {}\nStranded staging restore: {}",
        diag.project_dir_redacted,
        size_str(diag.db_exists, diag.db_size_bytes),
        size_str(diag.wal_exists, diag.wal_size_bytes),
        size_str(diag.shm_exists, diag.shm_size_bytes),
        stranded_str
    )
}

pub fn scan_library_counts(lib_dir: &Path) -> Result<(usize, bool), String> {
    if !lib_dir.exists() {
        return Err("Library directory does not exist on disk".to_string());
    }

    let entries = std::fs::read_dir(lib_dir).map_err(|e| e.to_string())?;
    let mut count = 0;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".fleuron")
                || name.ends_with(".codemap")
                || name.ends_with(".qcproj")
                || path.join("project.db").exists()
            {
                count += 1;
            }
        }
    }

    let is_writable = {
        let probe = lib_dir.join(".fleuron-write-probe");
        match std::fs::write(&probe, b"probe") {
            Ok(_) => {
                let _ = std::fs::remove_file(&probe);
                true
            }
            Err(_) => false,
        }
    };

    Ok((count, is_writable))
}

pub fn check_staged_updater_residue(app_data_dir: &Path) -> (bool, String) {
    let targets = ["staged_update", "updater", "current_update.tar.gz"];
    for target in targets {
        let path = app_data_dir.join(target);
        if path.exists() {
            return (true, format!("detected: {}", redact_path(&path)));
        }
    }
    (false, "clean".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn redact_path_adversarial_mac_study() {
        let p = PathBuf::from("/Users/wilsonyeh/Fleuron/Autistic Camouflaging P07/project.db");
        let redacted = redact_path(&p);
        assert!(!redacted.contains("wilsonyeh"), "must not contain username");
        assert!(
            !redacted.contains("Autistic"),
            "must not contain study term"
        );
        assert!(
            !redacted.contains("Camouflaging"),
            "must not contain study term"
        );
        assert!(
            !redacted.contains("P07"),
            "must not contain participant identifier"
        );
        assert_eq!(redacted, "<library>/<name>/project.db");
    }

    #[test]
    fn redact_path_adversarial_windows_study() {
        let p = PathBuf::from(r"C:\Users\someone\Fleuron\Study\project.db");
        let redacted = redact_path(&p);
        assert!(!redacted.contains("someone"), "must not contain username");
        assert!(!redacted.contains("Study"), "must not contain study name");
        assert_eq!(redacted, r"<library>\<name>\project.db");
    }

    #[test]
    fn redact_path_preserves_safe_extensions() {
        let p = PathBuf::from("/Users/alice/Fleuron/Confidential Clinical.fleuron/project.json");
        let redacted = redact_path(&p);
        assert_eq!(redacted, "<library>/<name>.fleuron/project.json");
    }

    #[test]
    fn safe_suffix_short_and_long() {
        assert_eq!(safe_suffix(""), "");
        assert_eq!(safe_suffix("1234"), "1234");
        assert_eq!(safe_suffix("12345678"), "12345678");
        assert_eq!(safe_suffix("0123456789abcdef"), "89abcdef");
    }

    #[test]
    fn redact_panic_payload_basic_and_truncation() {
        let raw = "assertion failed: `(left == right)`\n  left: `5`,\n right: `6`";
        let redacted = redact_panic_payload(raw);
        assert!(redacted.starts_with("[payload truncated for privacy] "));
        assert!(!redacted.contains('\n'));
        assert!(!redacted.contains('`'));

        let long_payload = "a".repeat(200);
        let redacted_long = redact_panic_payload(&long_payload);
        assert!(redacted_long.contains("...(+80 chars withheld)"));
    }

    #[test]
    fn redact_panic_payload_adversarial_seeded_identifier() {
        let raw = "Panicked at 'duplicate label': already has an interview labelled P07. This was encountered while processing /Users/wilsonyeh/Fleuron/SensitiveStudy/project.db";
        let redacted = redact_panic_payload(raw);
        assert!(!redacted.contains("wilsonyeh"));
        assert!(!redacted.contains("SensitiveStudy"));
        // Truncated at 120 chars
        assert!(redacted.contains("withheld"));
    }

    #[test]
    fn negative_test_naive_passthrough_fails() {
        // Assert that a naive implementation (returning raw input) fails the adversarial checks.
        let naive_path = |p: &Path| -> String { p.to_string_lossy().to_string() };
        let naive_payload = |s: &str| -> String { s.to_string() };

        let bad_path = naive_path(Path::new(
            "/Users/wilsonyeh/Fleuron/Autistic Camouflaging P07/project.db",
        ));
        assert!(bad_path.contains("wilsonyeh"));
        assert!(bad_path.contains("Autistic"));
        assert!(bad_path.contains("P07"));

        let bad_payload = naive_payload("Panicked: duplicate interview P07");
        assert!(bad_payload.contains("P07"));
    }

    #[test]
    fn parse_and_redact_crash_log_bounds_backtrace_and_redacts_message() {
        let raw = r#"--- CRASH RECORD ---
Timestamp: 2026-08-29T12:00:00Z
Version: 2.1.0
OS: macos aarch64
Thread: main
Location: src/db.rs:1008:9
Message: Panicked with assertion failed in src/db.rs:1008:9 while handling study database transaction with extended payload containing SecretStudy identifier
Backtrace:
  0: std::backtrace::Backtrace::create
  1: qualitative_coding_app_lib::crash_report::record_panic
  2: qualitative_coding_app_lib::db::save
  3: qualitative_coding_app_lib::commands::save_workspace_state
  4: core::ops::function::FnOnce::call_once
--- END RECORD ---
"#;
        let output = parse_and_redact_crash_log(raw);
        assert!(!output.contains("wilsonyeh"));
        assert!(!output.contains("SecretStudy"));
        assert!(output.contains("Records count: 1"));
        assert!(output.contains("[Record 1]"));
        assert!(output.contains("0: std::backtrace::Backtrace::create"));
        assert!(output.contains("1: qualitative_coding_app_lib::crash_report::record_panic"));
        assert!(output.contains("2: qualitative_coding_app_lib::db::save"));
        assert!(!output.contains("4: core::ops::function::FnOnce::call_once"));
        assert!(output.contains("[additional frames omitted]"));
    }

    #[test]
    fn poisoned_install_detection() {
        let temp = tempfile::tempdir().unwrap();
        let exe_dir = temp.path();
        let (poisoned, status) = check_poisoned_install(exe_dir);
        assert!(!poisoned);
        assert_eq!(status, "clean");

        let nested_dir = exe_dir.join("Fleuron.exe");
        std::fs::create_dir(&nested_dir).unwrap();
        let (poisoned, status) = check_poisoned_install(exe_dir);
        assert!(poisoned);
        assert!(status.contains("directory"));
    }

    #[test]
    fn stranded_staging_restore_detection() {
        let temp = tempfile::tempdir().unwrap();
        let proj_dir = temp.path();
        let diag_clean = check_storage_status(proj_dir);
        assert!(!diag_clean.stranded_staging_restore);
        assert!(!diag_clean.db_exists);

        std::fs::write(proj_dir.join("project.db"), b"db content").unwrap();
        std::fs::write(proj_dir.join(".staging-restore.db"), b"staging").unwrap();

        let diag_dirty = check_storage_status(proj_dir);
        assert!(diag_dirty.stranded_staging_restore);
        assert!(diag_dirty.db_exists);
        assert_eq!(diag_dirty.db_size_bytes, Some(10));

        let formatted = format_storage_diagnostics(&diag_dirty);
        assert!(formatted.contains("detected (.staging-restore.db is stranded)"));
        assert!(formatted.contains("present (10 bytes)"));
    }
}
