use crate::sync::SyncOutcome;
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncTrigger {
    LocalMutation,
    RealtimeHeadChanged,
    ProjectOpened,
    ProjectJoined,
    SessionRestored,
    SignedIn,
    WindowFocused,
    NetworkRecovered,
    ForegroundPoll,
    HiddenPoll,
    Manual,
    Repair,
    UpdaterPreflight,
}

impl SyncTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalMutation => "local_mutation",
            Self::RealtimeHeadChanged => "realtime_head_changed",
            Self::ProjectOpened => "project_opened",
            Self::ProjectJoined => "project_joined",
            Self::SessionRestored => "session_restored",
            Self::SignedIn => "signed_in",
            Self::WindowFocused => "window_focused",
            Self::NetworkRecovered => "network_recovered",
            Self::ForegroundPoll => "foreground_poll",
            Self::HiddenPoll => "hidden_poll",
            Self::Manual => "manual",
            Self::Repair => "repair",
            Self::UpdaterPreflight => "updater_preflight",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCoordinatorHealth {
    pub running: bool,
    pub rerun_requested: bool,
    pub generation: u64,
    pub last_trigger: Option<String>,
    pub backoff_attempt: u32,
    pub foreground: bool,
}

#[derive(Clone)]
pub struct SyncCoordinator {
    inner: Arc<Mutex<CoordinatorState>>,
    results: watch::Sender<Settlement>,
}

#[derive(Debug)]
struct CoordinatorState {
    active_generation: Option<u64>,
    next_generation: u64,
    rerun_requested: bool,
    last_trigger: Option<SyncTrigger>,
    backoff_attempt: u32,
    foreground: bool,
    last_local_mutation: Option<Instant>,
    last_remote_hint: Option<Instant>,
}

#[derive(Clone)]
struct Settlement {
    generation: u64,
    result: Option<Result<SyncOutcome, String>>,
}

pub struct SyncWaiter {
    generation: u64,
    receiver: watch::Receiver<Settlement>,
}

impl SyncCoordinator {
    pub fn new() -> Self {
        let (results, _) = watch::channel(Settlement {
            generation: 0,
            result: None,
        });
        Self {
            inner: Arc::new(Mutex::new(CoordinatorState {
                active_generation: None,
                next_generation: 0,
                rerun_requested: false,
                last_trigger: None,
                backoff_attempt: 0,
                foreground: true,
                last_local_mutation: None,
                last_remote_hint: None,
            })),
            results,
        }
    }

    pub fn request(&self, trigger: SyncTrigger) -> (bool, u64, SyncWaiter) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.last_trigger = Some(trigger);
        let now = Instant::now();
        match trigger {
            SyncTrigger::LocalMutation => state.last_local_mutation = Some(now),
            SyncTrigger::RealtimeHeadChanged => state.last_remote_hint = Some(now),
            SyncTrigger::Manual | SyncTrigger::WindowFocused | SyncTrigger::NetworkRecovered => {
                state.backoff_attempt = 0;
                state.last_local_mutation = None;
                state.last_remote_hint = None;
            }
            _ => {
                state.last_local_mutation = None;
                state.last_remote_hint = None;
            }
        }

        let (start, generation) = match state.active_generation {
            Some(generation) => {
                state.rerun_requested = true;
                (false, generation)
            }
            None => {
                state.next_generation = state.next_generation.saturating_add(1);
                let generation = state.next_generation;
                state.active_generation = Some(generation);
                state.rerun_requested = false;
                (true, generation)
            }
        };
        drop(state);

        (
            start,
            generation,
            SyncWaiter {
                generation,
                receiver: self.results.subscribe(),
            },
        )
    }

    pub fn is_active(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .active_generation
            == Some(generation)
    }

    pub fn with_active<T>(
        &self,
        generation: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active_generation != Some(generation) {
            return Err("Sync was cancelled because the project changed.".into());
        }
        action()
    }

    pub fn take_rerun(&self, generation: u64) -> bool {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active_generation != Some(generation) {
            return false;
        }
        let rerun = state.rerun_requested;
        state.rerun_requested = false;
        rerun
    }

    pub fn begin_pass(&self, generation: u64) -> bool {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active_generation != Some(generation) {
            return false;
        }
        state.rerun_requested = false;
        state.last_local_mutation = None;
        state.last_remote_hint = None;
        true
    }

    pub fn debounce_remaining(&self, generation: u64) -> Option<Duration> {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active_generation != Some(generation) {
            return None;
        }
        let now = Instant::now();
        let local_remaining = state
            .last_local_mutation
            .and_then(|at| at.checked_add(Duration::from_millis(250)))
            .map(|due| due.saturating_duration_since(now));
        let remote_remaining = state
            .last_remote_hint
            .and_then(|at| at.checked_add(Duration::from_millis(100)))
            .map(|due| due.saturating_duration_since(now));
        Some(
            local_remaining
                .into_iter()
                .chain(remote_remaining)
                .max()
                .unwrap_or(Duration::ZERO),
        )
    }

    pub fn finish(&self, generation: u64, result: Result<SyncOutcome, String>) -> bool {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active_generation != Some(generation) {
            return false;
        }
        state.active_generation = None;
        state.rerun_requested = false;
        if result.is_ok() {
            state.backoff_attempt = 0;
        } else {
            state.backoff_attempt = state.backoff_attempt.saturating_add(1).min(6);
        }
        drop(state);
        let _ = self.results.send(Settlement {
            generation,
            result: Some(result),
        });
        true
    }

    pub fn health(&self) -> SyncCoordinatorHealth {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        SyncCoordinatorHealth {
            running: state.active_generation.is_some(),
            rerun_requested: state.rerun_requested,
            generation: state.active_generation.unwrap_or(state.next_generation),
            last_trigger: state
                .last_trigger
                .map(|trigger| trigger.as_str().to_string()),
            backoff_attempt: state.backoff_attempt,
            foreground: state.foreground,
        }
    }

    pub fn set_foreground(&self, foreground: bool) {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .foreground = foreground;
    }

    pub fn is_foreground(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .foreground
    }

    pub fn cancel(&self) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(generation) = state.active_generation.take() else {
            return;
        };
        state.rerun_requested = false;
        drop(state);
        let _ = self.results.send(Settlement {
            generation,
            result: Some(Err("Sync was cancelled because the project changed.".into())),
        });
    }

    pub fn retry_delay(&self) -> Duration {
        let attempt = self.health().backoff_attempt.clamp(1, 6);
        full_jitter(backoff_cap(attempt))
    }
}

pub fn poll_interval(foreground: bool) -> Duration {
    if foreground {
        Duration::from_secs(15)
    } else {
        Duration::from_secs(60)
    }
}

fn backoff_cap(attempt: u32) -> Duration {
    let seconds = match attempt {
        1 => 1,
        2 => 2,
        3 => 5,
        4 => 10,
        5 => 30,
        _ => 60,
    };
    Duration::from_secs(seconds)
}

fn full_jitter(cap: Duration) -> Duration {
    let cap_ms = cap.as_millis() as u64;
    let entropy = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    Duration::from_millis(entropy % (cap_ms + 1))
}

impl SyncWaiter {
    pub async fn wait(mut self) -> Result<SyncOutcome, String> {
        loop {
            let settlement = self.receiver.borrow().clone();
            if settlement.generation == self.generation {
                if let Some(result) = settlement.result {
                    return result;
                }
            }
            self.receiver
                .changed()
                .await
                .map_err(|_| "Sync coordinator stopped before settling the request.".to_string())?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn triggers_during_a_pass_request_one_follow_up_pass() {
        let coordinator = SyncCoordinator::new();
        let (leader, generation, waiter) = coordinator.request(SyncTrigger::Manual);
        assert!(leader);
        let (follower, follower_generation, follower_waiter) =
            coordinator.request(SyncTrigger::RealtimeHeadChanged);
        assert!(!follower);
        assert_eq!(generation, follower_generation);
        let (_, local_generation, local_waiter) = coordinator.request(SyncTrigger::LocalMutation);
        assert_eq!(generation, local_generation);
        assert!(coordinator.take_rerun(generation));
        assert!(!coordinator.take_rerun(generation));
        assert!(coordinator.finish(generation, Ok(SyncOutcome::default())));
        assert!(waiter.wait().await.is_ok());
        assert!(follower_waiter.wait().await.is_ok());
        assert!(local_waiter.wait().await.is_ok());
    }

    #[test]
    fn local_bursts_wait_once_and_clear_the_preflight_rerun_latch() {
        let coordinator = SyncCoordinator::new();
        let (leader, generation, _) = coordinator.request(SyncTrigger::LocalMutation);
        assert!(leader);
        assert!(coordinator.debounce_remaining(generation).unwrap() > Duration::ZERO);
        let (follower, _, _) = coordinator.request(SyncTrigger::LocalMutation);
        assert!(!follower);
        assert!(coordinator.begin_pass(generation));
        assert!(!coordinator.take_rerun(generation));
    }

    #[tokio::test]
    async fn cancelled_generation_cannot_settle_or_apply_to_the_next_project() {
        let coordinator = SyncCoordinator::new();
        let (leader, first_generation, first_waiter) =
            coordinator.request(SyncTrigger::ProjectOpened);
        assert!(leader);
        coordinator.cancel();
        assert!(first_waiter.wait().await.is_err());

        let (leader, second_generation, second_waiter) =
            coordinator.request(SyncTrigger::ProjectOpened);
        assert!(leader);
        assert!(second_generation > first_generation);
        assert!(!coordinator.finish(first_generation, Ok(SyncOutcome::default())));
        assert!(coordinator.is_active(second_generation));
        assert!(coordinator.finish(second_generation, Ok(SyncOutcome::default())));
        assert!(second_waiter.wait().await.is_ok());
    }

    #[test]
    fn manual_focus_and_recovery_reset_backoff_without_losing_trigger_identity() {
        let coordinator = SyncCoordinator::new();
        let (leader, generation, _) = coordinator.request(SyncTrigger::ForegroundPoll);
        assert!(leader);
        assert!(coordinator.finish(generation, Err("synthetic network failure".into())));
        assert_eq!(coordinator.health().backoff_attempt, 1);
        let (leader, _, _) = coordinator.request(SyncTrigger::WindowFocused);
        assert!(leader);
        let health = coordinator.health();
        assert_eq!(health.backoff_attempt, 0);
        assert_eq!(health.last_trigger.as_deref(), Some("window_focused"));
    }

    #[test]
    fn poll_and_jitter_bounds_follow_the_recovery_contract() {
        assert_eq!(poll_interval(true), Duration::from_secs(15));
        assert_eq!(poll_interval(false), Duration::from_secs(60));
        for attempt in 1..=6 {
            assert!(full_jitter(backoff_cap(attempt)) <= backoff_cap(attempt));
        }
    }
}
