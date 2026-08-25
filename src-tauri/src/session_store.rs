use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[cfg(unix)]
use std::fs::OpenOptions;
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const SESSION_FILE: &str = "session.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredSession {
    pub refresh_token: String,
}

fn session_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(SESSION_FILE))
}

pub fn load(app: &tauri::AppHandle) -> Option<String> {
    let path = session_path(app)?;
    load_from_path(&path)
}

pub fn save(app: &tauri::AppHandle, refresh_token: &str) {
    if let Some(path) = session_path(app) {
        save_to_path(&path, refresh_token);
    }
}

pub fn clear(app: &tauri::AppHandle) {
    if let Some(path) = session_path(app) {
        clear_at_path(&path);
    }
}

pub(crate) fn load_from_path(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    let stored: StoredSession = serde_json::from_str(&raw).ok()?;
    if stored.refresh_token.trim().is_empty() {
        None
    } else {
        Some(stored.refresh_token)
    }
}

pub(crate) fn save_to_path(path: &Path, refresh_token: &str) {
    let Some(parent) = path.parent() else {
        return;
    };
    let _ = fs::create_dir_all(parent);

    let tmp_path = path.with_extension("json.tmp");
    let stored = StoredSession {
        refresh_token: refresh_token.to_string(),
    };
    let Ok(json) = serde_json::to_string_pretty(&stored) else {
        return;
    };

    #[cfg(unix)]
    {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        options.mode(0o600);
        if let Ok(mut file) = options.open(&tmp_path) {
            if file.write_all(json.as_bytes()).is_ok() && file.flush().is_ok() {
                let _ = fs::rename(&tmp_path, path);
            }
        }
    }

    #[cfg(not(unix))]
    {
        // On Windows, the ACL inherited from the per-user AppData directory
        // is the equivalent protection — access is restricted to the current user.
        if fs::write(&tmp_path, json).is_ok() {
            let _ = fs::rename(&tmp_path, path);
        }
    }
}

pub(crate) fn clear_at_path(path: &Path) {
    let _ = fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    #[test]
    fn round_trip_session_token() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(SESSION_FILE);

        assert_eq!(load_from_path(&path), None);

        save_to_path(&path, "sample_refresh_token_123");
        assert_eq!(
            load_from_path(&path),
            Some("sample_refresh_token_123".to_string())
        );

        clear_at_path(&path);
        assert_eq!(load_from_path(&path), None);
    }

    #[test]
    fn corrupt_or_truncated_file_returns_none() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(SESSION_FILE);

        fs::write(&path, "not json at all").unwrap();
        assert_eq!(load_from_path(&path), None);

        fs::write(&path, "{\"refresh_token\": \"\"}").unwrap();
        assert_eq!(load_from_path(&path), None);

        fs::write(&path, "").unwrap();
        assert_eq!(load_from_path(&path), None);
    }

    #[cfg(unix)]
    #[test]
    fn file_mode_is_0600_on_unix() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(SESSION_FILE);

        save_to_path(&path, "secret_token");
        let metadata = fs::metadata(&path).unwrap();
        let mode = metadata.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "File permissions must be 0600, got {:o}", mode);
    }
}
