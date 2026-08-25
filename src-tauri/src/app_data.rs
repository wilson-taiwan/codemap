use crate::models::{AppPreferences, RecentProject, RecordRecentProjectInput};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;
use uuid::Uuid;

const RECENT_MAX: usize = 8;
const RECENT_FILE: &str = "recent-projects.json";
const PREFS_FILE: &str = "app-preferences.json";
const MEMBERSHIPS_FILE: &str = "memberships.json";
const SYNC_DEVICE_ID_FILE: &str = "sync-device-id";

#[derive(Debug, Default, Serialize, Deserialize)]
struct RecentProjectsFile {
    #[serde(default)]
    projects: Vec<RecentProject>,
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq, Clone)]
pub struct MembershipsCache {
    #[serde(default)]
    pub memberships: Vec<crate::sync::MembershipSummary>,
    /// RFC 3339. Absent in a file written before this field existed.
    #[serde(default)]
    pub cached_at: Option<String>,
}

pub(crate) fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

pub(crate) fn get_or_create_sync_device_id_at(path: &Path) -> Result<String, String> {
    if path.exists() {
        let value = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let value = value.trim();
        Uuid::parse_str(value).map_err(|_| "Sync device identity is invalid.".to_string())?;
        return Ok(value.to_string());
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let value = Uuid::new_v4().to_string();
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(value.as_bytes())
                .map_err(|e| e.to_string())?;
            file.write_all(b"\n").map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            get_or_create_sync_device_id_at(path)
        }
        Err(error) => Err(error.to_string()),
    }
}

pub fn sync_device_id(app: &tauri::AppHandle) -> Result<String, String> {
    get_or_create_sync_device_id_at(&app_data_dir(app)?.join(SYNC_DEVICE_ID_FILE))
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T, String> {
    if !path.exists() {
        return Ok(T::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn list_recent_projects(app: &tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    let path = app_data_dir(app)?.join(RECENT_FILE);
    let mut file: RecentProjectsFile = read_json(&path)?;
    let before = file.projects.len();
    file.projects.retain(|p| Path::new(&p.path).exists());
    if file.projects.len() != before {
        write_json(&path, &file)?;
    }
    file.projects
        .sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
    Ok(file.projects)
}

pub(crate) fn truncate_recents_partition(projects: &mut Vec<RecentProject>) {
    let mut bound = Vec::new();
    let mut unbound = Vec::new();
    for p in projects.drain(..) {
        if p.group_id.is_some() {
            bound.push(p);
        } else {
            unbound.push(p);
        }
    }
    if unbound.len() > RECENT_MAX {
        unbound.truncate(RECENT_MAX);
    }
    projects.extend(bound);
    projects.extend(unbound);
    projects.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
}

pub fn record_recent_project(
    app: &tauri::AppHandle,
    input: RecordRecentProjectInput,
) -> Result<Vec<RecentProject>, String> {
    let path = app_data_dir(app)?.join(RECENT_FILE);
    let mut file: RecentProjectsFile = read_json(&path)?;

    let now = Utc::now().to_rfc3339();
    file.projects.retain(|p| p.path != input.path);

    file.projects.insert(
        0,
        RecentProject {
            path: input.path,
            title: input.title,
            last_opened_at: now,
            group_id: input.group_id,
            group_title: input.group_title,
            coder_name: input.coder_name,
        },
    );

    truncate_recents_partition(&mut file.projects);

    write_json(&path, &file)?;
    Ok(file.projects)
}

pub fn read_memberships_cache(app: &tauri::AppHandle) -> Result<MembershipsCache, String> {
    let path = app_data_dir(app)?.join(MEMBERSHIPS_FILE);
    read_json(&path)
}

pub fn write_memberships_cache(
    app: &tauri::AppHandle,
    memberships: &[crate::sync::MembershipSummary],
) -> Result<MembershipsCache, String> {
    let path = app_data_dir(app)?.join(MEMBERSHIPS_FILE);
    let cache = MembershipsCache {
        memberships: memberships.to_vec(),
        cached_at: Some(Utc::now().to_rfc3339()),
    };
    write_json(&path, &cache)?;
    Ok(cache)
}

pub fn clear_memberships_cache(app: &tauri::AppHandle) -> Result<(), String> {
    let path = app_data_dir(app)?.join(MEMBERSHIPS_FILE);
    let _ = fs::remove_file(path);
    Ok(())
}

pub fn remove_recent_project(
    app: &tauri::AppHandle,
    path: String,
) -> Result<Vec<RecentProject>, String> {
    let file_path = app_data_dir(app)?.join(RECENT_FILE);
    let mut file: RecentProjectsFile = read_json(&file_path)?;
    file.projects.retain(|p| p.path != path);
    write_json(&file_path, &file)?;
    Ok(file.projects)
}

/// The local working library — where incoming handoff files are unpacked.
///
/// Deliberately **not** configurable. A live project is a directory with an
/// open SQLite database inside it, and letting a user point this at their Box
/// or Drive folder would recreate the 0.4.0 WAL data-loss bug exactly: the
/// sync client would upload the database mid-write, file by file. Only the
/// *handoff destination* is a setting; the working copy always lives locally.
pub fn projects_library_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    Ok(base.join("Codemap"))
}

/// Which sync service, if any, appears to own this path.
///
/// Advisory only — the app does **not** refuse a synced location. Some people
/// deliberately keep projects in the cloud for backup, and that is their call
/// to make; the job here is to say so plainly at the moment of choosing rather
/// than let someone find out when a database goes missing.
///
/// Path matching is the whole mechanism on macOS, and that is not a shortcut:
/// File Provider mounts under `~/Library/CloudStorage` sit on the ordinary data
/// volume and report the same filesystem as everything else, so there is no
/// `statfs` signal to read. Verified on 2026-08-16 — a Box path reported
/// `/dev/disk3s1` on `/System/Volumes/Data`, identical to `~/Documents`.
///
/// Windows exposes a real registry of sync roots under
/// `HKCU\...\Explorer\SyncRootManager`, which would catch every provider
/// without naming any of them. Worth moving to; the prefix list below covers
/// the defaults in the meantime.
///
/// Deliberately best-effort. A miss must never be load-bearing — the bundle
/// integrity check in `db.rs` is what actually catches the failure this warns
/// about, whatever path it arrived by.
pub fn cloud_provider_for_path(app: &tauri::AppHandle, path: &Path) -> Option<String> {
    // Resolve symlinks first: a link into Box defeats naive prefix matching,
    // and `~/Documents` itself is a link into iCloud when the user has turned
    // on Desktop & Documents syncing.
    let real = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let s = real.to_string_lossy().replace('\\', "/");

    let home = app
        .path()
        .home_dir()
        .map(|h| h.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    // (path fragment, display name). Checked against the resolved path, so a
    // fragment matches wherever the provider actually mounted.
    const MARKERS: [(&str, &str); 10] = [
        ("/Library/Mobile Documents", "iCloud Drive"),
        ("/Library/CloudStorage/Box", "Box"),
        ("/Library/CloudStorage/Dropbox", "Dropbox"),
        ("/Library/CloudStorage/GoogleDrive", "Google Drive"),
        ("/Library/CloudStorage/OneDrive", "OneDrive"),
        ("/Library/CloudStorage/", "a cloud folder"),
        ("/Dropbox/", "Dropbox"),
        ("/OneDrive", "OneDrive"),
        ("/Google Drive/", "Google Drive"),
        ("/Box Sync/", "Box Sync"),
    ];

    let haystack = format!("{s}/");
    for (marker, name) in MARKERS {
        if haystack.contains(marker) {
            // The bare-name markers are only meaningful inside the user's own
            // profile — `/OneDrive` should not match `/srv/OneDriveBackup`.
            let profile_only = !marker.starts_with("/Library/");
            if profile_only && !home.is_empty() && !s.starts_with(&home) {
                continue;
            }
            return Some(name.to_string());
        }
    }
    None
}

pub fn get_app_preferences(app: &tauri::AppHandle) -> Result<AppPreferences, String> {
    let path = app_data_dir(app)?.join(PREFS_FILE);
    read_json(&path)
}

pub fn set_app_preferences(
    app: &tauri::AppHandle,
    prefs: AppPreferences,
) -> Result<AppPreferences, String> {
    let path = app_data_dir(app)?.join(PREFS_FILE);
    write_json(&path, &prefs)?;
    Ok(prefs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_partition_keeps_all_bound_and_caps_unbound_at_recent_max() {
        let mut projects = Vec::new();

        // 3 bound projects
        for i in 0..3 {
            projects.push(RecentProject {
                path: format!("/path/bound/{}", i),
                title: format!("Bound {}", i),
                last_opened_at: format!("2026-08-21T10:00:0{}Z", i),
                group_id: Some(format!("group-{}", i)),
                group_title: Some(format!("Group {}", i)),
                coder_name: Some("Ada".into()),
            });
        }

        // 12 unbound projects
        for i in 0..12 {
            projects.push(RecentProject {
                path: format!("/path/unbound/{}", i),
                title: format!("Unbound {}", i),
                last_opened_at: format!("2026-08-21T09:{:02}:00Z", i),
                group_id: None,
                group_title: None,
                coder_name: None,
            });
        }

        assert_eq!(projects.len(), 15);
        truncate_recents_partition(&mut projects);

        // All 3 bound projects must survive, and exactly 8 unbound remain -> 11 total
        assert_eq!(projects.len(), 11);
        let bound_count = projects.iter().filter(|p| p.group_id.is_some()).count();
        let unbound_count = projects.iter().filter(|p| p.group_id.is_none()).count();
        assert_eq!(bound_count, 3);
        assert_eq!(unbound_count, 8);
    }

    #[test]
    fn legacy_recent_projects_file_parses_cleanly() {
        let legacy_json = r#"{
            "projects": [
                {
                    "path": "/Users/ada/Documents/study-1",
                    "title": "Study 1",
                    "last_opened_at": "2026-08-20T12:00:00Z"
                }
            ]
        }"#;

        let parsed: RecentProjectsFile = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(parsed.projects.len(), 1);
        assert_eq!(parsed.projects[0].path, "/Users/ada/Documents/study-1");
        assert_eq!(parsed.projects[0].group_id, None);
        assert_eq!(parsed.projects[0].group_title, None);
        assert_eq!(parsed.projects[0].coder_name, None);
    }

    #[test]
    fn memberships_cache_file_round_trip_and_legacy_compatibility() {
        // Legacy file without cached_at
        let legacy_cache_json = r#"{
            "memberships": [
                {
                    "projectId": "proj-1",
                    "title": "Study Alpha",
                    "coderName": "Ada",
                    "members": ["Ada", "Hiroko"],
                    "role": "admin"
                }
            ]
        }"#;

        let parsed: MembershipsCache = serde_json::from_str(legacy_cache_json).unwrap();
        assert_eq!(parsed.memberships.len(), 1);
        assert_eq!(parsed.memberships[0].project_id, "proj-1");
        assert_eq!(parsed.memberships[0].members, vec!["Ada", "Hiroko"]);
        assert_eq!(parsed.cached_at, None);

        // Empty file / default
        let empty: MembershipsCache = serde_json::from_str("{}").unwrap();
        assert!(empty.memberships.is_empty());
        assert_eq!(empty.cached_at, None);
    }

    #[test]
    fn sync_device_identity_is_stable_and_kept_outside_project_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SYNC_DEVICE_ID_FILE);
        let first = get_or_create_sync_device_id_at(&path).unwrap();
        let second = get_or_create_sync_device_id_at(&path).unwrap();
        assert_eq!(first, second);
        assert!(Uuid::parse_str(&first).is_ok());
        assert_eq!(fs::read_to_string(path).unwrap().trim(), first);
    }
}
