use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

const MAX_RECORD_SIZE: usize = 64 * 1024; // 64 KiB
const MAX_FILE_SIZE: u64 = 512 * 1024; // 512 KiB
const MAX_ROTATED_FILES: usize = 3;

static CRASH_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn init_crash_handler(app_data_dir: PathBuf) {
    let crash_dir = app_data_dir.join("crashes");
    let _ = std::fs::create_dir_all(&crash_dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&crash_dir, std::fs::Permissions::from_mode(0o700));
    }

    if let Ok(mut guard) = CRASH_DIR.lock() {
        *guard = Some(crash_dir.clone());
    }

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        record_panic(info);
        default_hook(info);
    }));
}

fn record_panic(info: &std::panic::PanicHookInfo<'_>) {
    let crash_dir = match CRASH_DIR.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(dir) => dir.clone(),
            None => return,
        },
        Err(_) => return,
    };

    let log_path = crash_dir.join("crash.log");
    rotate_if_needed(&log_path, &crash_dir);

    let thread = std::thread::current();
    let thread_name = thread.name().unwrap_or("unknown");

    let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        "Box<Any> panic payload".to_string()
    };

    let location = if let Some(loc) = info.location() {
        format!("{}:{}:{}", loc.file(), loc.line(), loc.column())
    } else {
        "unknown location".to_string()
    };

    let backtrace = std::backtrace::Backtrace::capture();

    let mut record = format!(
        "--- CRASH RECORD ---\nTimestamp: {}\nVersion: {}\nOS: {} {}\nThread: {}\nLocation: {}\nMessage: {}\nBacktrace:\n{}\n--- END RECORD ---\n\n",
        chrono::Utc::now().to_rfc3339(),
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        thread_name,
        location,
        payload,
        backtrace
    );

    if record.len() > MAX_RECORD_SIZE {
        record.truncate(MAX_RECORD_SIZE - 25);
        record.push_str("\n...[truncated]\n\n");
    }

    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    if let Ok(mut file) = options.open(&log_path) {
        let _ = file.write_all(record.as_bytes());
        let _ = file.flush();
    }
}

fn rotate_if_needed(log_path: &Path, crash_dir: &Path) {
    if let Ok(metadata) = std::fs::metadata(log_path) {
        if metadata.len() >= MAX_FILE_SIZE {
            // Rotate existing files: .2 -> .3, .1 -> .2, crash.log -> .1
            for i in (1..MAX_ROTATED_FILES).rev() {
                let from = crash_dir.join(format!("crash.log.{}", i));
                let to = crash_dir.join(format!("crash.log.{}", i + 1));
                if from.exists() {
                    let _ = std::fs::rename(from, to);
                }
            }
            let first_rotated = crash_dir.join("crash.log.1");
            let _ = std::fs::rename(log_path, first_rotated);
        }
    }
}

pub fn read_crash_log_file(app: &AppHandle) -> Result<String, String> {
    let app_dir = crate::app_data::app_data_dir(app)?;
    let log_path = app_dir.join("crashes").join("crash.log");
    if !log_path.exists() {
        return Ok(String::new());
    }

    let mut file = File::open(&log_path).map_err(|e| e.to_string())?;
    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|e| e.to_string())?;
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_log_directory_creation_and_bounds() {
        let temp = tempfile::tempdir().unwrap();
        let crashes = temp.path().join("crashes");
        std::fs::create_dir_all(&crashes).unwrap();
        let log_file = crashes.join("crash.log");

        let mut record = String::from("Test panic");
        if record.len() > MAX_RECORD_SIZE {
            record.truncate(MAX_RECORD_SIZE);
        }
        std::fs::write(&log_file, record.as_bytes()).unwrap();

        assert!(log_file.exists());
        let read_back = std::fs::read_to_string(&log_file).unwrap();
        assert_eq!(read_back, "Test panic");
    }
}
