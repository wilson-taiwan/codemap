use crate::app_data;
use crate::commands::AppState;
use crate::run_marker;
use crate::sync_coordinator::SyncTrigger;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const UPDATE_STATE_EVENT: &str = "update://state";
const PENDING_UPDATE_FILE: &str = "pending-update.json";
const LAST_UPDATE_FILE: &str = "last-update.json";
const INSTALL_SENTINEL_FILE: &str = "update-installing.sentinel";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    ReadyToInstall,
    Preparing,
    Installing,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFailure {
    pub stage: String,
    pub retryable: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCoordinatorStatus {
    pub phase: UpdatePhase,
    pub current_version: String,
    pub target_version: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub last_checked_at: Option<String>,
    pub sync_preflight_outcome: Option<String>,
    pub failure: Option<UpdateFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PendingUpdateMarker {
    from_version: String,
    to_version: String,
    started_at: String,
    phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct LastUpdateRecord {
    from_version: String,
    to_version: String,
    completed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallSentinelV1 {
    pub schema: u32,
    pub installer_pid: u32,
    pub parent_pid: Option<u32>,
    pub target_version: String,
    pub phase: String,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InstallSentinelDiagnosticArchive {
    pub recovered_at: String,
    pub sentinel_format: String,
    pub target_version: Option<String>,
    pub phase: Option<String>,
}

struct UpdateCoordinatorInner {
    status: UpdateCoordinatorStatus,
    update: Option<Update>,
    verified_bytes: Option<Vec<u8>>,
    cancel_download: bool,
}

pub struct UpdateCoordinator {
    inner: Mutex<UpdateCoordinatorInner>,
}

impl UpdateCoordinator {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(UpdateCoordinatorInner {
                status: UpdateCoordinatorStatus {
                    phase: UpdatePhase::Idle,
                    current_version: env!("CARGO_PKG_VERSION").to_string(),
                    target_version: None,
                    downloaded_bytes: 0,
                    total_bytes: None,
                    last_checked_at: None,
                    sync_preflight_outcome: None,
                    failure: None,
                },
                update: None,
                verified_bytes: None,
                cancel_download: false,
            }),
        }
    }

    pub fn status(&self) -> UpdateCoordinatorStatus {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .status
            .clone()
    }

    fn publish(&self, app: &AppHandle) -> UpdateCoordinatorStatus {
        let status = self.status();
        let _ = app.emit(UPDATE_STATE_EVENT, &status);
        status
    }

    fn set_failed(
        &self,
        app: &AppHandle,
        stage: &str,
        message: &str,
        retryable: bool,
    ) -> UpdateCoordinatorStatus {
        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner.status.phase = UpdatePhase::Failed;
            inner.status.failure = Some(UpdateFailure {
                stage: stage.to_string(),
                retryable,
                message: message.to_string(),
            });
        }
        self.publish(app)
    }

    fn updater_for(&self, app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
        let pending_marker = pending_marker_path(app)?;
        let install_sentinel = install_sentinel_path(app)?;
        let before_exit_app = app.clone();
        app.updater_builder()
            .timeout(Duration::from_secs(10))
            .installer_args([
                format!("/FLEURON_PARENT_PID={}", std::process::id()),
                nsis_argument("FLEURON_PENDING_UPDATE", &pending_marker),
                nsis_argument("FLEURON_INSTALL_SENTINEL", &install_sentinel),
            ])
            .on_before_exit(move || {
                let state = before_exit_app.state::<AppState>();
                state.set_update_write_blocked(true);
                state.sync_coordinator.cancel();
                state.realtime.stop(&before_exit_app);
                let _ = state.close_project_connection_for_update();
                if let Ok(app_dir) = app_data::app_data_dir(&before_exit_app) {
                    run_marker::remove_current_run_marker(&app_dir);
                }
            })
            .build()
            .map_err(|_| "The updater is unavailable on this build.".to_string())
    }

    pub async fn check(&self, app: AppHandle) -> Result<UpdateCoordinatorStatus, String> {
        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !can_check(&inner.status.phase) {
                return Err("An update operation is already in progress.".into());
            }
            inner.status.phase = UpdatePhase::Checking;
            inner.status.failure = None;
            inner.status.downloaded_bytes = 0;
            inner.status.total_bytes = None;
            inner.status.sync_preflight_outcome = None;
            inner.verified_bytes = None;
            inner.update = None;
            inner.cancel_download = false;
        }
        self.publish(&app);

        let updater = match self.updater_for(&app) {
            Ok(updater) => updater,
            Err(error) => return Ok(self.set_failed(&app, "check", &error, true)),
        };
        match updater.check().await {
            Ok(Some(update)) => {
                {
                    let mut inner = self
                        .inner
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    inner.status.phase = UpdatePhase::Available;
                    inner.status.target_version = Some(update.version.clone());
                    inner.status.last_checked_at = Some(Utc::now().to_rfc3339());
                    inner.status.failure = None;
                    inner.update = Some(update);
                }
                Ok(self.publish(&app))
            }
            Ok(None) => {
                {
                    let mut inner = self
                        .inner
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    inner.status.phase = UpdatePhase::Idle;
                    inner.status.target_version = None;
                    inner.status.last_checked_at = Some(Utc::now().to_rfc3339());
                    inner.status.failure = None;
                }
                Ok(self.publish(&app))
            }
            Err(_) => Ok(self.set_failed(
                &app,
                "check",
                "Could not check for an update. Try again when you are online.",
                true,
            )),
        }
    }

    pub async fn download(&self, app: AppHandle) -> Result<UpdateCoordinatorStatus, String> {
        let update = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !can_download(&inner) {
                return Err("Check for an available update before downloading it.".into());
            }
            inner.status.phase = UpdatePhase::Downloading;
            inner.status.downloaded_bytes = 0;
            inner.status.total_bytes = None;
            inner.status.failure = None;
            inner.cancel_download = false;
            inner
                .update
                .take()
                .ok_or("The update metadata is no longer available. Check again.")?
        };
        self.publish(&app);

        let progress_app = app.clone();
        let download = update
            .download(
                |chunk_length, total_bytes| {
                    self.record_download_progress(&progress_app, chunk_length as u64, total_bytes);
                },
                || {},
            )
            .await;
        let cancelled = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .cancel_download;

        match download {
            Ok(bytes) if !cancelled => {
                {
                    let mut inner = self
                        .inner
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    inner.status.phase = UpdatePhase::ReadyToInstall;
                    inner.status.downloaded_bytes = bytes.len() as u64;
                    inner.status.total_bytes = Some(bytes.len() as u64);
                    inner.status.failure = None;
                    inner.verified_bytes = Some(bytes);
                    inner.update = Some(update);
                    inner.cancel_download = false;
                }
                Ok(self.publish(&app))
            }
            Ok(_) => {
                {
                    let mut inner = self
                        .inner
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    inner.status.phase = UpdatePhase::Available;
                    inner.status.downloaded_bytes = 0;
                    inner.status.total_bytes = None;
                    inner.status.failure = None;
                    inner.verified_bytes = None;
                    inner.update = Some(update);
                    inner.cancel_download = false;
                }
                Ok(self.publish(&app))
            }
            Err(_) => {
                {
                    let mut inner = self
                        .inner
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    inner.status.phase = UpdatePhase::Available;
                    inner.status.downloaded_bytes = 0;
                    inner.status.total_bytes = None;
                    inner.status.failure = Some(UpdateFailure {
                        stage: "download".into(),
                        retryable: true,
                        message: "The update could not be downloaded or verified. Fleuron is still open and writable.".into(),
                    });
                    inner.verified_bytes = None;
                    inner.update = Some(update);
                    inner.cancel_download = false;
                }
                Ok(self.publish(&app))
            }
        }
    }

    pub fn cancel_download(&self, app: AppHandle) -> Result<UpdateCoordinatorStatus, String> {
        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.status.phase != UpdatePhase::Downloading {
                return Err("There is no update download to cancel.".into());
            }
            inner.cancel_download = true;
        }
        Ok(self.publish(&app))
    }

    pub async fn install(
        &self,
        app: AppHandle,
        state: &AppState,
    ) -> Result<UpdateCoordinatorStatus, String> {
        let (update, bytes, target_version) = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !can_install(&inner) {
                return Err("Download and verify the update before installing it.".into());
            }
            inner.status.phase = UpdatePhase::Preparing;
            inner.status.failure = None;
            let target_version = inner.status.target_version.clone().unwrap_or_default();
            let update = inner
                .update
                .take()
                .ok_or("The verified update metadata is missing. Check again.")?;
            let bytes = inner
                .verified_bytes
                .take()
                .ok_or("The verified update bytes are missing. Download again.")?;
            (update, bytes, target_version)
        };
        self.publish(&app);

        state.set_update_write_blocked(true);
        let preflight = tokio::time::timeout(
            Duration::from_secs(5),
            state.request_sync(app.clone(), SyncTrigger::UpdaterPreflight),
        )
        .await;
        let sync_preflight_outcome = match preflight {
            Ok(Ok(_)) => "synced",
            Ok(Err(_)) => "offline_or_failed",
            Err(_) => "timed_out",
        }
        .to_string();
        state.sync_coordinator.cancel();
        state.realtime.stop(&app);
        if let Err(error) = state.close_project_connection_for_update() {
            return Ok(
                self.resume_after_install_failure(&app, state, update, bytes, "prepare", &error)
            );
        }

        if let Err(error) = write_pending_marker(
            &app,
            &PendingUpdateMarker {
                from_version: env!("CARGO_PKG_VERSION").to_string(),
                to_version: target_version.clone(),
                started_at: Utc::now().to_rfc3339(),
                phase: "installing".into(),
            },
        ) {
            return Ok(
                self.resume_after_install_failure(&app, state, update, bytes, "prepare", &error)
            );
        }

        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner.status.phase = UpdatePhase::Installing;
            inner.status.sync_preflight_outcome = Some(sync_preflight_outcome);
        }
        self.publish(&app);

        match update.install(&bytes) {
            Ok(()) => {
                #[cfg(not(target_os = "windows"))]
                app.request_restart();
                Ok(self.status())
            }
            Err(_) => Ok(self.resume_after_install_failure(
                &app,
                state,
                update,
                bytes,
                "install",
                "The update could not be installed. Fleuron reopened your existing project.",
            )),
        }
    }

    fn resume_after_install_failure(
        &self,
        app: &AppHandle,
        state: &AppState,
        update: Update,
        bytes: Vec<u8>,
        stage: &str,
        message: &str,
    ) -> UpdateCoordinatorStatus {
        let _ = mark_pending_update_failed(app);
        let _ = state.reopen_project_connection_after_update_failure();
        state.set_update_write_blocked(false);
        state.maybe_start_realtime(app);
        state.request_background_sync(app.clone(), SyncTrigger::NetworkRecovered);
        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            inner.update = Some(update);
            inner.verified_bytes = Some(bytes);
        }
        self.set_failed(app, stage, message, true)
    }

    fn record_download_progress(
        &self,
        app: &AppHandle,
        chunk_length: u64,
        total_bytes: Option<u64>,
    ) {
        {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if inner.status.phase != UpdatePhase::Downloading {
                return;
            }
            inner.status.total_bytes = total_bytes;
            inner.status.downloaded_bytes =
                inner.status.downloaded_bytes.saturating_add(chunk_length);
        }
        self.publish(app);
    }

    pub fn reconcile_startup(&self, app: &AppHandle) {
        let Ok(Some(marker)) = read_pending_marker(app) else {
            return;
        };
        if pending_update_failure_path(app).is_ok_and(|path| path.exists()) {
            let _ = clear_pending_update_failure(app);
            let _ = mark_pending_update_failed(app);
            self.set_failed(
                app,
                "installer",
                "The installer restored the prior Fleuron executable after verification failed. You can retry after checking for updates.",
                true,
            );
            return;
        }
        let current_version = env!("CARGO_PKG_VERSION");
        match classify_pending_marker(current_version, &marker) {
            PendingMarkerDisposition::Succeeded => {
                let _ = write_last_update_record(app, &marker);
                let _ = clear_pending_marker(app);
            }
            PendingMarkerDisposition::StillOnPreviousVersion => {
                let _ = mark_pending_update_failed(app);
                self.set_failed(
                    app,
                    "launch",
                    "The previous update did not finish. You can retry it after checking for updates.",
                    true,
                );
            }
            PendingMarkerDisposition::UnexpectedVersion => {
                let _ = mark_pending_update_failed(app);
                self.set_failed(
                    app,
                    "launch",
                    "Fleuron started with an unexpected version after an update attempt. Normal startup is available; collect diagnostics before retrying.",
                    true,
                );
            }
        }
    }
}

fn can_check(phase: &UpdatePhase) -> bool {
    matches!(
        phase,
        UpdatePhase::Idle | UpdatePhase::Available | UpdatePhase::Failed
    )
}

fn can_download(inner: &UpdateCoordinatorInner) -> bool {
    matches!(
        inner.status.phase,
        UpdatePhase::Available | UpdatePhase::Failed
    ) && inner.update.is_some()
        && inner.verified_bytes.is_none()
}

fn can_install(inner: &UpdateCoordinatorInner) -> bool {
    matches!(
        inner.status.phase,
        UpdatePhase::ReadyToInstall | UpdatePhase::Failed
    ) && inner.update.is_some()
        && inner.verified_bytes.is_some()
}

fn pending_marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data::app_data_dir(app)?.join(PENDING_UPDATE_FILE))
}

pub(crate) fn install_sentinel_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data::app_data_dir(app)?.join(INSTALL_SENTINEL_FILE))
}

fn pending_update_failure_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(pending_marker_path(app)?.with_extension("json.failed"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartupInstallGuard {
    Allow,
    InstallerActive,
    StaleSentinelRecovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SentinelDisposition {
    Active,
    StaleRecovered,
}

pub fn classify_sentinel_content<F>(
    content: &str,
    file_age: Duration,
    is_process_alive: F,
) -> SentinelDisposition
where
    F: Fn(u32) -> bool,
{
    if let Ok(sentinel) = serde_json::from_str::<InstallSentinelV1>(content) {
        if is_process_alive(sentinel.installer_pid) {
            SentinelDisposition::Active
        } else {
            SentinelDisposition::StaleRecovered
        }
    } else if content.trim() == "installing" {
        if file_age < Duration::from_secs(10 * 60) {
            SentinelDisposition::Active
        } else {
            SentinelDisposition::StaleRecovered
        }
    } else {
        SentinelDisposition::StaleRecovered
    }
}

#[cfg(target_os = "windows")]
fn is_pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let result = WaitForSingleObject(handle, 0);
        CloseHandle(handle);
        result == WAIT_TIMEOUT
    }
}

#[cfg(not(target_os = "windows"))]
fn is_pid_alive(_pid: u32) -> bool {
    false
}

pub(crate) fn startup_install_guard(app: &AppHandle) -> StartupInstallGuard {
    let Ok(path) = install_sentinel_path(app) else {
        return StartupInstallGuard::Allow;
    };
    if !path.exists() {
        return StartupInstallGuard::Allow;
    }
    let Ok(metadata) = fs::metadata(&path) else {
        return StartupInstallGuard::Allow;
    };
    let Ok(content) = fs::read_to_string(&path) else {
        return StartupInstallGuard::Allow;
    };
    let age = metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .unwrap_or_default();

    match classify_sentinel_content(&content, age, is_pid_alive) {
        SentinelDisposition::Active => StartupInstallGuard::InstallerActive,
        SentinelDisposition::StaleRecovered => {
            archive_stale_sentinel(&path, &content);
            StartupInstallGuard::StaleSentinelRecovered
        }
    }
}

fn archive_stale_sentinel(path: &Path, content: &str) {
    let archive_path = path.with_file_name(format!(
        "stale-update-sentinel-{}.json",
        Utc::now().format("%Y%m%dT%H%M%SZ")
    ));
    let parsed = serde_json::from_str::<InstallSentinelV1>(content).ok();
    let diagnostic = InstallSentinelDiagnosticArchive {
        recovered_at: Utc::now().to_rfc3339(),
        sentinel_format: if parsed.is_some() {
            "v1_json".to_string()
        } else if content.trim() == "installing" {
            "legacy_plaintext".to_string()
        } else {
            "malformed".to_string()
        },
        target_version: parsed.as_ref().map(|s| s.target_version.clone()),
        phase: parsed.as_ref().map(|s| s.phase.clone()),
    };
    if let Ok(body) = serde_json::to_vec_pretty(&diagnostic) {
        let _ = fs::write(&archive_path, body);
    }
    let _ = fs::remove_file(path);
}

fn nsis_argument(name: &str, value: &Path) -> String {
    let value = value.to_string_lossy().replace('"', "");
    format!("/{name}=\"{value}\"")
}

fn write_pending_marker(app: &AppHandle, marker: &PendingUpdateMarker) -> Result<(), String> {
    let path = pending_marker_path(app)?;
    let body = serde_json::to_vec_pretty(marker).map_err(|error| error.to_string())?;
    let temporary_path = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary_path).map_err(|error| error.to_string())?;
    file.write_all(&body).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary_path, path).map_err(|error| error.to_string())
}

fn read_pending_marker(app: &AppHandle) -> Result<Option<PendingUpdateMarker>, String> {
    let path = pending_marker_path(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|_| "The pending update marker is invalid.".to_string())
}

fn clear_pending_marker(app: &AppHandle) -> Result<(), String> {
    let path = pending_marker_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn clear_pending_update_failure(app: &AppHandle) -> Result<(), String> {
    let path = pending_update_failure_path(app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn mark_pending_update_failed(app: &AppHandle) -> Result<(), String> {
    let Some(mut marker) = read_pending_marker(app)? else {
        return Ok(());
    };
    marker.phase = "failed".into();
    write_pending_marker(app, &marker)
}

fn write_last_update_record(app: &AppHandle, marker: &PendingUpdateMarker) -> Result<(), String> {
    let path = app_data::app_data_dir(app)?.join(LAST_UPDATE_FILE);
    let record = LastUpdateRecord {
        from_version: marker.from_version.clone(),
        to_version: marker.to_version.clone(),
        completed_at: Utc::now().to_rfc3339(),
    };
    let serialized = serde_json::to_vec_pretty(&record).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PendingMarkerDisposition {
    Succeeded,
    StillOnPreviousVersion,
    UnexpectedVersion,
}

fn classify_pending_marker(
    current_version: &str,
    marker: &PendingUpdateMarker,
) -> PendingMarkerDisposition {
    if current_version == marker.to_version {
        PendingMarkerDisposition::Succeeded
    } else if current_version == marker.from_version {
        PendingMarkerDisposition::StillOnPreviousVersion
    } else {
        PendingMarkerDisposition::UnexpectedVersion
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(from_version: &str, to_version: &str) -> PendingUpdateMarker {
        PendingUpdateMarker {
            from_version: from_version.into(),
            to_version: to_version.into(),
            started_at: "2026-08-23T00:00:00Z".into(),
            phase: "installing".into(),
        }
    }

    #[test]
    fn only_idle_available_or_failed_can_start_a_check() {
        assert!(can_check(&UpdatePhase::Idle));
        assert!(can_check(&UpdatePhase::Available));
        assert!(can_check(&UpdatePhase::Failed));
        assert!(!can_check(&UpdatePhase::Downloading));
        assert!(!can_check(&UpdatePhase::ReadyToInstall));
        assert!(!can_check(&UpdatePhase::Preparing));
        assert!(!can_check(&UpdatePhase::Installing));
    }

    #[test]
    fn pending_marker_version_matrix_is_explicit() {
        assert_eq!(
            classify_pending_marker("0.27.0", &marker("0.26.1", "0.27.0")),
            PendingMarkerDisposition::Succeeded
        );
        assert_eq!(
            classify_pending_marker("0.26.1", &marker("0.26.1", "0.27.0")),
            PendingMarkerDisposition::StillOnPreviousVersion
        );
        assert_eq!(
            classify_pending_marker("0.28.0", &marker("0.26.1", "0.27.0")),
            PendingMarkerDisposition::UnexpectedVersion
        );
    }

    #[test]
    fn nsis_argument_keeps_the_marker_path_explicit() {
        let value = PathBuf::from("C:/Users/Test User/AppData/pending-update.json");
        assert_eq!(
            nsis_argument("FLEURON_PENDING_UPDATE", &value),
            "/FLEURON_PENDING_UPDATE=\"C:/Users/Test User/AppData/pending-update.json\""
        );
    }

    #[test]
    fn structured_sentinel_classification_with_liveness_injection() {
        let json_sentinel = r#"{
            "schema": 1,
            "installer_pid": 12345,
            "parent_pid": 6789,
            "target_version": "0.27.1",
            "phase": "waiting_for_release",
            "started_at": "2026-08-24T00:00:00Z"
        }"#;

        // Active when owner PID is alive
        assert_eq!(
            classify_sentinel_content(json_sentinel, Duration::from_secs(5), |pid| pid == 12345),
            SentinelDisposition::Active
        );

        // StaleRecovered immediately when owner PID is dead (even if 0 seconds old)
        assert_eq!(
            classify_sentinel_content(json_sentinel, Duration::from_secs(0), |_pid| false),
            SentinelDisposition::StaleRecovered
        );
    }

    #[test]
    fn legacy_plaintext_sentinel_bounded_age_fallback() {
        let legacy_sentinel = "installing\r\n";

        // Under 10 minutes -> Active
        assert_eq!(
            classify_sentinel_content(legacy_sentinel, Duration::from_secs(9 * 60), |_pid| false),
            SentinelDisposition::Active
        );

        // Over 10 minutes -> StaleRecovered
        assert_eq!(
            classify_sentinel_content(legacy_sentinel, Duration::from_secs(11 * 60), |_pid| false),
            SentinelDisposition::StaleRecovered
        );
    }

    #[test]
    fn malformed_sentinel_recovers_immediately() {
        let malformed = "corrupt content {not json";
        assert_eq!(
            classify_sentinel_content(malformed, Duration::from_secs(0), |_pid| true),
            SentinelDisposition::StaleRecovered
        );
    }
}
