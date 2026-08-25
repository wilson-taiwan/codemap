use std::fs::OpenOptions;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

static UNCLEAN_EXIT_DETECTED: AtomicBool = AtomicBool::new(false);

#[derive(serde::Serialize, serde::Deserialize)]
struct MarkerPayload {
    pid: u32,
    started_at: String,
    version: String,
}

pub fn init_run_marker(app_data_dir: &Path) {
    let marker_dir = app_data_dir.join("run-markers");
    let _ = std::fs::create_dir_all(&marker_dir);

    let lock_file_path = marker_dir.join("run-markers.lock");
    let lock_file = match OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_file_path)
    {
        Ok(f) => f,
        Err(_) => return,
    };

    // Lock file during inspection and marker registration
    let _ = fs2::FileExt::lock_exclusive(&lock_file);

    let my_pid = std::process::id();
    let mut unclean = false;

    if let Ok(entries) = std::fs::read_dir(&marker_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if file_name.starts_with("running-") && file_name.ends_with(".marker") {
                let pid_str = file_name
                    .trim_start_matches("running-")
                    .trim_end_matches(".marker");
                if let Ok(pid) = pid_str.parse::<u32>() {
                    if pid != my_pid && !is_process_alive(pid) {
                        unclean = true;
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }

    if unclean {
        UNCLEAN_EXIT_DETECTED.store(true, Ordering::SeqCst);
    }

    // Write current marker
    let my_marker_path = marker_dir.join(format!("running-{}.marker", my_pid));
    let payload = MarkerPayload {
        pid: my_pid,
        started_at: chrono::Utc::now().to_rfc3339(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
    if let Ok(data) = serde_json::to_string_pretty(&payload) {
        let _ = std::fs::write(&my_marker_path, data);
    }

    let _ = fs2::FileExt::unlock(&lock_file);
}

pub fn remove_current_run_marker(app_data_dir: &Path) {
    let my_pid = std::process::id();
    let marker_path = app_data_dir
        .join("run-markers")
        .join(format!("running-{}.marker", my_pid));
    let _ = std::fs::remove_file(marker_path);
}

pub fn take_unclean_exit_notice() -> bool {
    UNCLEAN_EXIT_DETECTED.swap(false, Ordering::SeqCst)
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    unsafe {
        // kill(pid, 0) checks if process exists without sending a signal
        if libc::kill(pid as libc::pid_t, 0) == 0 {
            true
        } else {
            let err = std::io::Error::last_os_error().raw_os_error();
            // ESRCH means process does not exist. EPERM means it exists but owned by another user.
            err != Some(libc::ESRCH)
        }
    }
}

#[cfg(windows)]
fn is_process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let success = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        success != 0 && exit_code == STILL_ACTIVE as u32
    }
}

#[cfg(not(any(unix, windows)))]
fn is_process_alive(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_lifecycle_and_take_notice() {
        UNCLEAN_EXIT_DETECTED.store(true, Ordering::SeqCst);
        assert!(take_unclean_exit_notice());
        assert!(!take_unclean_exit_notice());
    }
}
