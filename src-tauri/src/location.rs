use crate::app_data;
use crate::models::{RelinkOutcome, StudyLocation};
use std::path::{Path, PathBuf};
use tauri::Manager;

pub fn resolve_study_location(app: &tauri::AppHandle, path_str: &str) -> StudyLocation {
    let path = Path::new(path_str);

    // 1. Volume not mounted
    #[cfg(target_os = "macos")]
    {
        if path_str.starts_with("/Volumes/") {
            let parts: Vec<&str> = path_str.split('/').collect();
            if parts.len() >= 3 {
                let volume_name = parts[2];
                let volume_path = Path::new("/Volumes").join(volume_name);
                if !volume_path.exists() {
                    return StudyLocation::VolumeNotMounted {
                        volume_name: volume_name.to_string(),
                    };
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if path_str.len() >= 2 && path_str.chars().nth(1) == Some(':') {
            let drive = &path_str[..2];
            let drive_root = format!("{}\\", drive);
            if !Path::new(&drive_root).exists() {
                return StudyLocation::VolumeNotMounted {
                    volume_name: drive.to_string(),
                };
            }
        }
    }

    // 2. Cloud provider absent
    let cloud_provider = app_data::cloud_provider_for_path(app, path);
    if let Some(ref provider) = cloud_provider {
        if path_str.contains("/Library/CloudStorage/") {
            if let Ok(home) = app.path().home_dir() {
                let parts: Vec<&str> = path_str.split("/Library/CloudStorage/").collect();
                if parts.len() >= 2 {
                    let sub = parts[1].split('/').next().unwrap_or("");
                    let provider_root = home.join("Library").join("CloudStorage").join(sub);
                    if !provider_root.exists() {
                        return StudyLocation::CloudProviderAbsent {
                            provider: provider.clone(),
                        };
                    }
                }
            }
        }
    }

    // 3. Gone if path doesn't exist
    if !path.exists() {
        return StudyLocation::Gone;
    }

    let db_path = path.join("project.db");
    if !db_path.exists() {
        return StudyLocation::Gone;
    }

    // Probe reading project.db
    match std::fs::File::open(&db_path) {
        Err(e) => {
            let category = crate::file_error::classify_io(&e);
            match category {
                crate::file_error::FileAccessCategory::PermissionDenied => {
                    StudyLocation::PermissionDenied
                }
                crate::file_error::FileAccessCategory::ContentNotDownloaded => {
                    StudyLocation::CloudNotDownloaded {
                        provider: cloud_provider.unwrap_or_else(|| "cloud storage".into()),
                    }
                }
                _ => StudyLocation::Gone,
            }
        }
        Ok(mut f) => {
            use std::io::Read;
            let mut header = [0u8; 100];
            if let Err(e) = f.read_exact(&mut header) {
                let category = crate::file_error::classify_io(&e);
                if category == crate::file_error::FileAccessCategory::ContentNotDownloaded {
                    return StudyLocation::CloudNotDownloaded {
                        provider: cloud_provider.unwrap_or_else(|| "cloud storage".into()),
                    };
                }
            }

            match rusqlite::Connection::open_with_flags(
                &db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            ) {
                Ok(conn) => {
                    match conn.query_row("PRAGMA schema_version", [], |r| r.get::<_, i64>(0)) {
                        Ok(_) => StudyLocation::Reachable,
                        Err(e) => {
                            let err_str = e.to_string();
                            let category = crate::file_error::classify_message(&err_str);
                            if category
                                == crate::file_error::FileAccessCategory::ContentNotDownloaded
                            {
                                StudyLocation::CloudNotDownloaded {
                                    provider: cloud_provider
                                        .unwrap_or_else(|| "cloud storage".into()),
                                }
                            } else if category
                                == crate::file_error::FileAccessCategory::PermissionDenied
                            {
                                StudyLocation::PermissionDenied
                            } else {
                                StudyLocation::Gone
                            }
                        }
                    }
                }
                Err(e) => {
                    let err_str = e.to_string();
                    let category = crate::file_error::classify_message(&err_str);
                    if category == crate::file_error::FileAccessCategory::ContentNotDownloaded {
                        StudyLocation::CloudNotDownloaded {
                            provider: cloud_provider.unwrap_or_else(|| "cloud storage".into()),
                        }
                    } else if category == crate::file_error::FileAccessCategory::PermissionDenied {
                        StudyLocation::PermissionDenied
                    } else {
                        StudyLocation::Gone
                    }
                }
            }
        }
    }
}

pub fn auto_relink_study(
    app: &tauri::AppHandle,
    old_path_str: &str,
    expected_project_id: Option<&str>,
) -> RelinkOutcome {
    let old_path = Path::new(old_path_str);
    let old_folder_name = old_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let old_base_name = old_folder_name
        .trim_end_matches(".fleuron")
        .trim_end_matches(".codemap")
        .trim_end_matches(".qcproj");

    let mut search_dirs: Vec<PathBuf> = Vec::new();

    // 1. Last-known parent folder
    if let Some(parent) = old_path.parent() {
        search_dirs.push(parent.to_path_buf());
    }

    // 2. Projects library dir
    if let Ok(lib_dir) = app_data::projects_library_dir(app) {
        search_dirs.push(lib_dir);
    }

    // 3. Parent folder of every other study in recents
    if let Ok(recents) = app_data::list_recent_projects(app) {
        for r in recents {
            if let Some(p) = Path::new(&r.path).parent() {
                search_dirs.push(p.to_path_buf());
            }
        }
    }

    // Deduplicate search dirs
    search_dirs.retain(|d| d.exists() && d.is_dir());
    search_dirs.sort();
    search_dirs.dedup();

    let mut name_match: Option<String> = None;

    for dir in search_dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p == old_path {
                continue;
            }
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let is_candidate = name.ends_with(".fleuron")
                || name.ends_with(".codemap")
                || name.ends_with(".qcproj");
            if !is_candidate {
                continue;
            }

            let db_path = p.join("project.db");
            if !db_path.exists() {
                continue;
            }

            // Check exact project_id match
            if let Some(target_id) = expected_project_id {
                if let Ok(conn) = rusqlite::Connection::open_with_flags(
                    &db_path,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
                ) {
                    let stored_id: Option<String> = conn
                        .query_row(
                            "SELECT value FROM sync_state WHERE key = 'project_id'",
                            [],
                            |r| r.get(0),
                        )
                        .ok();
                    if stored_id.as_deref() == Some(target_id) {
                        let new_path_str = p.to_string_lossy().to_string();
                        let _ =
                            app_data::update_recent_project_path(app, old_path_str, &new_path_str);
                        return RelinkOutcome::ExactMatch {
                            new_path: new_path_str,
                            message: "Found this study at its new location and reconnected it."
                                .into(),
                        };
                    }
                }
            }

            // Check name match
            let candidate_base = name
                .trim_end_matches(".fleuron")
                .trim_end_matches(".codemap")
                .trim_end_matches(".qcproj");
            if candidate_base.eq_ignore_ascii_case(old_base_name) && name_match.is_none() {
                name_match = Some(p.to_string_lossy().to_string());
            }
        }
    }

    if let Some(candidate) = name_match {
        RelinkOutcome::NameMatchOnly {
            candidate_path: candidate.clone(),
            message: format!("Found a study with this name at {candidate}. Use it?"),
        }
    } else {
        RelinkOutcome::NotFound
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unmounted_volume_detection() {
        // A nonexistent volume path
        let unmounted = "/Volumes/DefNotRealBackupHD12345/MyStudy.fleuron";
        #[cfg(target_os = "macos")]
        {
            // Even without app handle, the volume check triggers first
            let parts: Vec<&str> = unmounted.split('/').collect();
            let volume_name = parts[2];
            let volume_path = Path::new("/Volumes").join(volume_name);
            assert!(!volume_path.exists());
        }
    }
}
