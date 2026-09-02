use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

pub const OPEN_MARKER_FILE: &str = ".fleuron-open.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenMarker {
    pub machine_name: String,
    pub coder_name: String,
    pub pid: u32,
    pub opened_at: String,
    pub heartbeat_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum OpenMarkerStatus {
    Clear,
    #[serde(rename_all = "camelCase")]
    ActiveOtherMachine {
        machine_name: String,
        coder_name: String,
        minutes_ago: u64,
    },
}

pub fn get_machine_name() -> String {
    #[cfg(windows)]
    {
        if let Ok(name) = std::env::var("COMPUTERNAME") {
            if !name.trim().is_empty() {
                return name.trim().to_string();
            }
        }
    }
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        let res = unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if res == 0 {
            if let Ok(s) = std::ffi::CStr::from_bytes_until_nul(&buf) {
                if let Ok(name) = s.to_str() {
                    if !name.trim().is_empty() {
                        return name.trim().to_string();
                    }
                }
            }
        }
        if let Ok(name) = std::env::var("HOSTNAME") {
            if !name.trim().is_empty() {
                return name.trim().to_string();
            }
        }
    }
    "Unknown Computer".to_string()
}

pub fn check_marker(project_path: &Path, my_machine: &str) -> OpenMarkerStatus {
    let marker_path = project_path.join(OPEN_MARKER_FILE);
    if !marker_path.exists() {
        return OpenMarkerStatus::Clear;
    }

    let Ok(contents) = fs::read_to_string(&marker_path) else {
        return OpenMarkerStatus::Clear;
    };

    let Ok(marker) = serde_json::from_str::<OpenMarker>(&contents) else {
        return OpenMarkerStatus::Clear;
    };

    if marker.machine_name.eq_ignore_ascii_case(my_machine) {
        return OpenMarkerStatus::Clear;
    }

    let Ok(heartbeat) = DateTime::parse_from_rfc3339(&marker.heartbeat_at) else {
        return OpenMarkerStatus::Clear;
    };

    let now = Utc::now();
    let diff = now.signed_duration_since(heartbeat.with_timezone(&Utc));
    let minutes = diff.num_minutes();

    if (0..15).contains(&minutes) {
        OpenMarkerStatus::ActiveOtherMachine {
            machine_name: marker.machine_name,
            coder_name: marker.coder_name,
            minutes_ago: minutes as u64,
        }
    } else {
        OpenMarkerStatus::Clear
    }
}

pub fn write_marker(
    project_path: &Path,
    machine_name: &str,
    coder_name: &str,
) -> Result<(), String> {
    let marker_path = project_path.join(OPEN_MARKER_FILE);
    let now = Utc::now().to_rfc3339();
    let marker = OpenMarker {
        machine_name: machine_name.to_string(),
        coder_name: coder_name.to_string(),
        pid: std::process::id(),
        opened_at: now.clone(),
        heartbeat_at: now,
    };
    let json = serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?;
    fs::write(marker_path, json).map_err(|e| e.to_string())
}

pub fn heartbeat_marker(project_path: &Path) -> Result<(), String> {
    let marker_path = project_path.join(OPEN_MARKER_FILE);
    if !marker_path.exists() {
        return Ok(());
    }
    let contents = fs::read_to_string(&marker_path).map_err(|e| e.to_string())?;
    let mut marker: OpenMarker = serde_json::from_str(&contents).map_err(|e| e.to_string())?;
    marker.heartbeat_at = Utc::now().to_rfc3339();
    let json = serde_json::to_string_pretty(&marker).map_err(|e| e.to_string())?;
    fs::write(marker_path, json).map_err(|e| e.to_string())
}

pub fn remove_marker(project_path: &Path) {
    let marker_path = project_path.join(OPEN_MARKER_FILE);
    let _ = fs::remove_file(marker_path);
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn marker_freshness_matrix() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path();

        // 1. Absent marker
        assert_eq!(check_marker(path, "My-Mac"), OpenMarkerStatus::Clear);

        // 2. This machine (same machine name) -> ignored even if fresh
        write_marker(path, "My-Mac", "Wilson").unwrap();
        assert_eq!(check_marker(path, "My-Mac"), OpenMarkerStatus::Clear);

        // 3. Fresh other machine -> ActiveOtherMachine
        write_marker(path, "FIELDWORK-PC", "Hiroko").unwrap();
        match check_marker(path, "My-Mac") {
            OpenMarkerStatus::ActiveOtherMachine {
                machine_name,
                coder_name,
                minutes_ago,
            } => {
                assert_eq!(machine_name, "FIELDWORK-PC");
                assert_eq!(coder_name, "Hiroko");
                assert!(minutes_ago <= 1);
            }
            other => panic!("expected ActiveOtherMachine, got {:?}", other),
        }

        // 4. Stale other machine (> 15 minutes) -> Clear
        let stale_heartbeat = (Utc::now() - Duration::minutes(20)).to_rfc3339();
        let stale_marker = OpenMarker {
            machine_name: "FIELDWORK-PC".to_string(),
            coder_name: "Hiroko".to_string(),
            pid: 1234,
            opened_at: stale_heartbeat.clone(),
            heartbeat_at: stale_heartbeat,
        };
        fs::write(
            path.join(OPEN_MARKER_FILE),
            serde_json::to_string(&stale_marker).unwrap(),
        )
        .unwrap();
        assert_eq!(check_marker(path, "My-Mac"), OpenMarkerStatus::Clear);

        // 5. Malformed JSON -> Clear
        fs::write(path.join(OPEN_MARKER_FILE), b"not valid json").unwrap();
        assert_eq!(check_marker(path, "My-Mac"), OpenMarkerStatus::Clear);

        // 6. Remove marker cleans up
        remove_marker(path);
        assert!(!path.join(OPEN_MARKER_FILE).exists());
    }
}
