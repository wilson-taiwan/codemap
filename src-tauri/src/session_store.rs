//! Stored sign-in: only the refresh token, never the password.
//!
//! Per-OS storage backends (v1.2):
//!   - macOS/Unix: atomic `session.json` with mode 0600. Keychain is
//!     deliberately NOT used while builds are ad-hoc signed — each rebuild
//!     changes the CDHash and Keychain would re-prompt on every launch.
//!   - Windows: raw DPAPI ciphertext in `session.dpapi`, bound to the current
//!     user on this machine (see [`crate::dpapi`]). Legacy plaintext v1.1
//!     `session.json` migrates silently on load and is deleted only after the
//!     protected blob verifies; failure keeps the legacy file for a retry on
//!     the next launch so nobody is signed out by a storage hiccup.

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
const DPAPI_FILE: &str = "session.dpapi";

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredSession {
    pub refresh_token: String,
}

pub(crate) fn data_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

/// Only the Unix backend keeps a plain session file; Windows stores a DPAPI
/// blob instead, so this is unreachable there.
#[cfg(unix)]
fn session_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    data_dir(app).map(|d| d.join(SESSION_FILE))
}

// ---------------------------------------------------------------------------
// Shared public surface
// ---------------------------------------------------------------------------

pub fn load(app: &tauri::AppHandle) -> Option<String> {
    #[cfg(unix)]
    {
        let path = session_path(app)?;
        load_from_path(&path)
    }
    #[cfg(windows)]
    {
        let dir = data_dir(app)?;
        load_windows(&dir)
    }
}

pub fn save(app: &tauri::AppHandle, refresh_token: &str) {
    #[cfg(unix)]
    {
        if let Some(path) = session_path(app) {
            save_to_path(&path, refresh_token);
        }
    }
    #[cfg(windows)]
    {
        let dir = data_dir(app);
        if let Some(dir) = dir {
            save_windows(&dir, refresh_token);
        }
    }
}

pub fn clear(app: &tauri::AppHandle) {
    // Sign-out removes every stored artifact on every platform.
    if let Some(dir) = data_dir(app) {
        clear_dir_artifacts(&dir);
    }
}

/// Delete all known session artifacts (legacy json, protected blob, temps).
pub(crate) fn clear_dir_artifacts(dir: &Path) {
    let _ = fs::remove_file(dir.join(SESSION_FILE));
    let _ = fs::remove_file(dir.join(SESSION_FILE).with_extension("json.tmp"));
    let _ = fs::remove_file(dir.join(DPAPI_FILE));
    let _ = fs::remove_file(dir.join(DPAPI_FILE).with_extension("dpapi.tmp"));
}

// ---------------------------------------------------------------------------
// Unix/macOS backend — atomic mode-0600 JSON file
// ---------------------------------------------------------------------------

#[cfg(unix)]
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

#[cfg(unix)]
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

    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    options.mode(0o600);
    if let Ok(mut file) = options.open(&tmp_path) {
        if file.write_all(json.as_bytes()).is_ok() && file.flush().is_ok() {
            let _ = fs::rename(&tmp_path, path);
        }
    }
}

// ---------------------------------------------------------------------------
// Windows backend — DPAPI blob with silent legacy migration
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod windows_backend {
    use super::*;

    fn dpapi_path(dir: &Path) -> PathBuf {
        dir.join(DPAPI_FILE)
    }

    /// Write fresh sign-ins only as protected blobs. Never write a new
    /// plaintext fallback; if protection fails we keep the session in memory
    /// for this launch and simply try again next time.
    pub(super) fn save_windows(dir: &Path, refresh_token: &str) {
        let Some(cipher) = crate::dpapi::protect(refresh_token.as_bytes()) else {
            return;
        };
        write_blob_atomic(&dpapi_path(dir), &cipher);
    }

    pub(super) fn read_protected(path: &Path) -> Option<String> {
        let cipher = fs::read(path).ok()?;
        crate::dpapi::unprotect(&cipher)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|t| !t.trim().is_empty())
    }

    fn write_blob_atomic(path: &Path, bytes: &[u8]) {
        let Some(parent) = path.parent() else { return };
        let _ = fs::create_dir_all(parent);
        let tmp = path.with_extension("dpapi.tmp");
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }

    /// Load order: protected blob first; if absent, a valid legacy v1.1
    /// `session.json` is used for this launch while it silently migrates.
    pub(super) fn load_windows(dir: &Path) -> Option<String> {
        let protected = dpapi_path(dir);
        let legacy = dir.join(SESSION_FILE);

        if protected.exists() {
            // A corrupt legacy file alongside a good blob must not linger:
            // sign-out/rotation paths below keep this tidy regardless.
            if let Some(token) = read_protected(&protected) {
                let _ = fs::remove_file(&legacy);
                return Some(token);
            }
            // Protected data that will not decrypt -- corrupt, half-written,
            // or produced under another user/machine context -- is not on its
            // own a reason to sign the user out. The plaintext is deleted only
            // after a VERIFIED round-trip, so if it is still on disk it is
            // still valid, and refusing it would sign the user out while that
            // very file sits there: no security gained, a session lost. Fall
            // through and retry the migration. With no legacy file the block
            // below yields None, so a lone corrupt blob still means no token.
        }

        // No usable protected artifact: attempt silent migration from legacy.
        let token = super::load_legacy_from_path(&legacy)?;
        save_windows(dir, &token);

        // Migration success means: protected blob decrypts to the same token,
        // and ONLY THEN may the plaintext disappear.
        if read_protected(&protected).as_deref() == Some(token.as_str()) {
            let _ = fs::remove_file(&legacy);
            let _ = fs::remove_file(legacy.with_extension("json.tmp"));
        }
        // Either way this launch signs in with the legacy token.
        Some(token)
    }
}

#[cfg(windows)]
use windows_backend::{load_windows, save_windows};

/// Parse the legacy v1.1 plaintext format. Runtime use is Windows migration;
/// kept available to tests on every platform via cfg below.
#[cfg(any(windows, test))]
pub(crate) fn load_legacy_from_path(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    let stored: StoredSession = serde_json::from_str(&raw).ok()?;
    let token = stored.refresh_token;
    if token.trim().is_empty() {
        None
    } else {
        Some(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    #[test]
    fn legacy_loader_rejects_empty_tokens() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(SESSION_FILE);
        fs::write(&path, "{\"refresh_token\": \"  \"}").unwrap();
        assert_eq!(load_legacy_from_path(&path), None);
        fs::write(&path, "{\"refresh_token\": \"tok\"}").unwrap();
        assert_eq!(load_legacy_from_path(&path), Some("tok".into()));
    }

    #[cfg(unix)]
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

        let _ = fs::remove_file(&path);
        assert_eq!(load_from_path(&path), None);
    }

    #[cfg(unix)]
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

    // -- Windows-native tests (run under the GitHub Actions runner account;
    //    they exercise REAL DPAPI, which is exactly what CI can prove). ----

    #[cfg(windows)]
    mod windows_only {
        use super::*;
        use windows_backend as wb;

        const TOKEN: &str = "windows_refresh_token_real_dpapi";

        fn seed_legacy(dir: &Path, token: &str) -> PathBuf {
            let legacy = dir.join(SESSION_FILE);
            fs::write(
                &legacy,
                serde_json::to_string_pretty(&StoredSession {
                    refresh_token: token.into(),
                })
                .unwrap(),
            )
            .unwrap();
            legacy
        }

        #[test]
        fn dpapi_round_trip_same_user() {
            let cipher = crate::dpapi::protect(TOKEN.as_bytes()).unwrap();
            let plain = crate::dpapi::unprotect(&cipher).unwrap();
            assert_eq!(String::from_utf8(plain).unwrap(), TOKEN);
        }

        #[test]
        fn wrong_or_corrupt_blob_yields_no_token() {
            assert!(
                crate::dpapi::unprotect(b"totally not dpapi output").is_none(),
                "corrupt blob must fail without surfacing a Win32 error"
            );
            let empty: Vec<u8> = Vec::new();
            assert!(crate::dpapi::unprotect(&empty).is_none());
        }

        #[test]
        fn save_then_load_prefers_dpapi_and_never_writes_new_plaintext() {
            let dir = tempdir().unwrap();
            wb::save_windows(dir.path(), TOKEN);
            assert!(dir.path().join(DPAPI_FILE).exists());
            assert!(
                !dir.path().join(SESSION_FILE).exists(),
                "fresh sign-ins must never create plaintext session.json"
            );
            assert_eq!(wb::load_windows(dir.path()), Some(TOKEN.into()));
        }

        #[test]
        fn corrupt_protected_blob_yields_no_token_not_a_raw_error() {
            let dir = tempdir().unwrap();
            fs::write(dir.path().join(DPAPI_FILE), b"garbage bytes 0xDEADBEEF").unwrap();
            assert_eq!(wb::load_windows(dir.path()), None);
        }

        #[test]
        fn legacy_plaintext_silently_migrates_then_disappears() {
            let dir = tempdir().unwrap();
            let legacy = seed_legacy(dir.path(), TOKEN);

            assert_eq!(wb::load_windows(dir.path()), Some(TOKEN.into()));
            assert!(
                dir.path().join(DPAPI_FILE).exists(),
                "protected blob must exist after migration"
            );
            assert!(
                !legacy.exists(),
                "legacy file must be deleted only after verified protection"
            );

            // Migrated state loads again cleanly without the legacy file.
            assert_eq!(wb::load_windows(dir.path()), Some(TOKEN.into()));
        }

        #[test]
        fn migration_failure_keeps_legacy_for_retry_next_launch() {
            // Make the protected-blob write impossible: `session.dpapi` exists
            // as a DIRECTORY, so the atomic rename must fail while every other
            // step behaves. The user stays signed in this launch and the
            // plaintext remains for a retry on the next one.
            let dir = tempdir().unwrap();
            fs::create_dir(dir.path().join(DPAPI_FILE)).unwrap();
            let legacy = seed_legacy(dir.path(), TOKEN);

            assert_eq!(
                wb::load_windows(dir.path()),
                Some(TOKEN.into()),
                "user must stay signed in even when protection fails"
            );
            assert!(
                legacy.exists(),
                "legacy plaintext must be preserved when migration could not verify"
            );
        }

        #[test]
        fn clear_removes_every_session_artifact() {
            let dir = tempdir().unwrap();
            wb::save_windows(dir.path(), TOKEN);
            assert!(dir.path().join(DPAPI_FILE).exists());
            super::clear_dir_artifacts(dir.path());
            assert!(!dir.path().join(DPAPI_FILE).exists());
            assert!(!dir.path().join(SESSION_FILE).exists());
        }
    }
}
