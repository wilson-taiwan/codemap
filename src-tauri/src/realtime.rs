//! Supabase Realtime WebSocket client in Rust.
//!
//! Subscribes to PostgreSQL database changes over Phoenix channels and emits
//! Tauri events to the webview. The webview's CSP deliberately forbids external
//! network access, so this socket must live in Rust.
//!
//! Realtime messages are treated as NOTIFICATIONS ONLY — payloads are never
//! applied directly to SQLite. Receiving an event triggers a debounced REST pull
//! in the frontend which runs through the full three-way merge pipeline.

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::broadcast;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteChangeEvent {
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PresenceUser {
    pub coder_name: String,
    pub participant_label: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RealtimeHealth {
    Off,
    Connecting,
    Connected,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhoenixMessage {
    pub topic: String,
    pub event: String,
    pub payload: serde_json::Value,
    #[serde(default)]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub join_ref: Option<String>,
}

pub fn channel_topic(project_id: &str) -> String {
    format!("realtime:codemap:{project_id}")
}

fn postgres_changes_config(project_id: &str, sync_protocol: i64) -> Vec<serde_json::Value> {
    if sync_protocol == 2 {
        return vec![serde_json::json!({
            "event": "*",
            "schema": "public",
            "table": "sync_project_heads",
            "filter": format!("project_id=eq.{project_id}"),
            "select": ["project_id", "generation", "head_seq"]
        })];
    }
    vec![
        serde_json::json!({ "event": "*", "schema": "public", "table": "coded_segments", "filter": format!("project_id=eq.{project_id}"), "select": ["project_id"] }),
        serde_json::json!({ "event": "*", "schema": "public", "table": "codebook", "filter": format!("project_id=eq.{project_id}"), "select": ["project_id"] }),
        serde_json::json!({ "event": "*", "schema": "public", "table": "interviews", "filter": format!("project_id=eq.{project_id}"), "select": ["project_id"] }),
    ]
}

fn head_hint_from_payload(payload: &serde_json::Value) -> (Option<String>, Option<i64>) {
    let record = payload
        .pointer("/data/record")
        .or_else(|| payload.pointer("/data/new_record"));
    let Some(record) = record else {
        return (None, None);
    };
    let generation = record
        .get("generation")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map(str::to_string);
    let head = record
        .get("head_seq")
        .or_else(|| record.get("head"))
        .and_then(serde_json::Value::as_i64)
        .filter(|value| *value >= 0);
    (generation, head)
}

pub fn compute_backoff(attempt: u32) -> Duration {
    let base_secs = 1u64.checked_shl(attempt.min(6)).unwrap_or(64);
    let capped = base_secs.min(60);
    // Deterministic jitter based on attempt
    let jitter_ms = (attempt * 137) % 500;
    Duration::from_millis(capped * 1000 + jitter_ms as u64)
}

pub fn flatten_presence(
    presence_map: &HashMap<String, HashMap<String, PresenceUser>>,
    local_conn_key: &str,
) -> Vec<PresenceUser> {
    let mut seen_coders = HashSet::new();
    let mut result = Vec::new();
    for (conn_key, metas) in presence_map {
        if conn_key == local_conn_key {
            continue;
        }
        for user in metas.values() {
            if seen_coders.insert(user.coder_name.clone()) {
                result.push(user.clone());
            }
        }
    }
    result.sort_by(|a, b| a.coder_name.cmp(&b.coder_name));
    result
}

pub struct RealtimeManager {
    shutdown_tx: std::sync::Mutex<Option<broadcast::Sender<()>>>,
    generation: Arc<AtomicU64>,
    health: Arc<std::sync::Mutex<RealtimeHealth>>,
}

impl RealtimeManager {
    pub fn new() -> Self {
        Self {
            shutdown_tx: std::sync::Mutex::new(None),
            generation: Arc::new(AtomicU64::new(0)),
            health: Arc::new(std::sync::Mutex::new(RealtimeHealth::Off)),
        }
    }

    pub fn health(&self) -> RealtimeHealth {
        *self.health.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn is_connected(&self) -> bool {
        self.health() == RealtimeHealth::Connected
    }

    pub fn stop<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) {
        {
            let mut guard = self.shutdown_tx.lock().unwrap_or_else(|p| p.into_inner());
            self.generation.fetch_add(1, Ordering::SeqCst);
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
        {
            let mut h = self.health.lock().unwrap_or_else(|p| p.into_inner());
            *h = RealtimeHealth::Off;
        }
        let _ = app.emit("sync://presence-change", Vec::<PresenceUser>::new());
    }

    // Realtime has distinct authentication, project, actor, and protocol inputs;
    // keeping them explicit avoids accidentally reusing a stale session bundle.
    #[allow(clippy::too_many_arguments)]
    pub fn start<R: tauri::Runtime + 'static>(
        &self,
        app: tauri::AppHandle<R>,
        url: String,
        anon_key: String,
        token: String,
        project_id: String,
        my_coder_name: String,
        sync_protocol: i64,
    ) {
        if std::env::var("CODEMAP_DISABLE_REALTIME").ok().as_deref() == Some("1") {
            return;
        }

        let (current_gen, shutdown_rx) = {
            let mut guard = self.shutdown_tx.lock().unwrap_or_else(|p| p.into_inner());
            let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
            let (new_tx, new_rx) = broadcast::channel::<()>(4);
            *guard = Some(new_tx);
            (gen, new_rx)
        };

        {
            let mut h = self.health.lock().unwrap_or_else(|p| p.into_inner());
            *h = RealtimeHealth::Connecting;
        }
        let _ = app.emit("sync://presence-change", Vec::<PresenceUser>::new());

        let generation = Arc::clone(&self.generation);
        let health = Arc::clone(&self.health);

        tauri::async_runtime::spawn(async move {
            run_realtime_task(
                app,
                url,
                anon_key,
                token,
                project_id,
                my_coder_name,
                sync_protocol,
                current_gen,
                generation,
                health,
                shutdown_rx,
            )
            .await;
        });
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SessionOutcome {
    Reconnect,
    Shutdown,
}

#[allow(clippy::too_many_arguments)]
async fn run_realtime_task<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    url: String,
    anon_key: String,
    token: String,
    project_id: String,
    my_coder_name: String,
    sync_protocol: i64,
    task_gen: u64,
    manager_gen: Arc<AtomicU64>,
    health: Arc<std::sync::Mutex<RealtimeHealth>>,
    mut shutdown_rx: broadcast::Receiver<()>,
) {
    let mut attempt = 0u32;
    let ws_origin = url
        .replace("https://", "wss://")
        .replace("http://", "ws://");
    let ws_url = format!(
        "{}/realtime/v1/websocket?apikey={}&vsn=1.0.0",
        ws_origin.trim_end_matches('/'),
        anon_key
    );

    loop {
        if manager_gen.load(Ordering::SeqCst) != task_gen {
            break;
        }

        let socket_opened_at = std::time::Instant::now();

        tokio::select! {
            _ = shutdown_rx.recv() => {
                break;
            }
            conn_res = connect_async(&ws_url) => {
                if manager_gen.load(Ordering::SeqCst) != task_gen {
                    break;
                }
                if let Ok((mut ws_stream, _)) = conn_res {
                    let outcome = drive_phoenix_session(
                        &app,
                        &mut ws_stream,
                        &project_id,
                        &token,
                        &my_coder_name,
                        sync_protocol,
                        task_gen,
                        &manager_gen,
                        &health,
                        &mut shutdown_rx,
                    )
                    .await;

                    if outcome == SessionOutcome::Shutdown {
                        break;
                    }

                    if socket_opened_at.elapsed() >= Duration::from_secs(60) {
                        attempt = 0;
                    }
                }
            }
        }

        if manager_gen.load(Ordering::SeqCst) != task_gen {
            break;
        }

        {
            let mut h = health.lock().unwrap_or_else(|p| p.into_inner());
            if *h == RealtimeHealth::Connected {
                *h = RealtimeHealth::Connecting;
            }
        }

        let delay = compute_backoff(attempt);
        attempt = attempt.saturating_add(1);

        tokio::select! {
            _ = shutdown_rx.recv() => {
                break;
            }
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive_phoenix_session<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    ws_stream: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    project_id: &str,
    token: &str,
    my_coder_name: &str,
    sync_protocol: i64,
    task_gen: u64,
    manager_gen: &Arc<AtomicU64>,
    health: &Arc<std::sync::Mutex<RealtimeHealth>>,
    shutdown_rx: &mut broadcast::Receiver<()>,
) -> SessionOutcome {
    let topic = channel_topic(project_id);
    let local_conn_key = uuid::Uuid::new_v4().to_string();
    let join_ref = "1".to_string();

    let join_payload = serde_json::json!({
        "config": {
            "private": false,
            "broadcast": { "ack": false, "self": false },
            "presence": { "enabled": true, "key": local_conn_key },
            "postgres_changes": postgres_changes_config(project_id, sync_protocol)
        },
        "access_token": token
    });

    let join_msg = PhoenixMessage {
        topic: topic.clone(),
        event: "phx_join".into(),
        payload: join_payload,
        r#ref: Some(join_ref.clone()),
        join_ref: Some(join_ref.clone()),
    };

    let text = match serde_json::to_string(&join_msg) {
        Ok(t) => t,
        Err(_) => return SessionOutcome::Reconnect,
    };

    if ws_stream.send(Message::Text(text.into())).await.is_err() {
        return SessionOutcome::Reconnect;
    }

    let mut msg_ref_counter = 2u64;
    let mut join_accepted = false;
    let mut postgres_subscription_ids = HashSet::new();
    let mut is_subscribed_to_postgres = false;
    let mut presence_map: HashMap<String, HashMap<String, PresenceUser>> = HashMap::new();

    let heartbeat_duration = if cfg!(test) || std::env::var("CODEMAP_TEST_HEARTBEAT_MS").is_ok() {
        Duration::from_millis(50)
    } else {
        Duration::from_secs(20)
    };
    let mut heartbeat_interval = tokio::time::interval_at(
        tokio::time::Instant::now() + heartbeat_duration,
        heartbeat_duration,
    );

    loop {
        if manager_gen.load(Ordering::SeqCst) != task_gen {
            return SessionOutcome::Shutdown;
        }

        tokio::select! {
            _ = shutdown_rx.recv() => {
                return SessionOutcome::Shutdown;
            }
            _ = heartbeat_interval.tick() => {
                let next_ref = msg_ref_counter.to_string();
                msg_ref_counter += 1;
                let hb = PhoenixMessage {
                    topic: "phoenix".into(),
                    event: "heartbeat".into(),
                    payload: serde_json::json!({}),
                    r#ref: Some(next_ref),
                    join_ref: None,
                };
                if let Ok(text) = serde_json::to_string(&hb) {
                    if ws_stream.send(Message::Text(text.into())).await.is_err() {
                        return SessionOutcome::Reconnect;
                    }
                }
            }
            msg = ws_stream.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let parsed = match serde_json::from_str::<PhoenixMessage>(&text) {
                            Ok(p) => p,
                            Err(_) => continue,
                        };

                        if parsed.event == "phx_reply" {
                            if parsed.topic == topic && parsed.r#ref.as_deref() == Some(&join_ref) {
                                if let Some(status) = parsed.payload.get("status").and_then(|s| s.as_str()) {
                                    if status == "ok" {
                                        join_accepted = true;
                                        if let Some(pcs) = parsed.payload.get("response").and_then(|r| r.get("postgres_changes")).and_then(|pc| pc.as_array()) {
                                            for item in pcs {
                                                if let Some(id) = item.get("id").and_then(|i| i.as_i64()) {
                                                    postgres_subscription_ids.insert(id);
                                                }
                                            }
                                        }
                                    } else {
                                        return SessionOutcome::Reconnect;
                                    }
                                }
                            }
                        } else if parsed.event == "system" && parsed.topic == topic && parsed.payload.get("extension").and_then(|s| s.as_str()) == Some("postgres_changes") {
                            let status = parsed.payload.get("status").and_then(|s| s.as_str());
                            let message = parsed.payload.get("message").and_then(|s| s.as_str());
                            if status == Some("ok") && message == Some("Subscribed to PostgreSQL") && join_accepted {
                                is_subscribed_to_postgres = true;
                                if manager_gen.load(Ordering::SeqCst) == task_gen {
                                    {
                                        let mut h = health.lock().unwrap_or_else(|p| p.into_inner());
                                        *h = RealtimeHealth::Connected;
                                    }
                                    let _ = app.emit("sync://realtime-connected", ());
                                    let _ = app.emit("sync://remote-change", RemoteChangeEvent {
                                        project_id: project_id.to_string(),
                                        generation: None,
                                        head: None,
                                    });
                                    let next_ref = msg_ref_counter.to_string();
                                    msg_ref_counter += 1;
                                    let now_iso = chrono::Utc::now().to_rfc3339();
                                    let track_msg = PhoenixMessage {
                                        topic: topic.clone(),
                                        event: "presence".into(),
                                        payload: serde_json::json!({
                                            "type": "presence",
                                            "event": "track",
                                            "payload": {
                                                "coder_name": my_coder_name,
                                                "participant_label": "",
                                                "updated_at": now_iso,
                                            }
                                        }),
                                        r#ref: Some(next_ref),
                                        join_ref: Some(join_ref.clone()),
                                    };
                                    if let Ok(text) = serde_json::to_string(&track_msg) {
                                        let _ = ws_stream.send(Message::Text(text.into())).await;
                                    }
                                }
                            } else if status == Some("error") && manager_gen.load(Ordering::SeqCst) == task_gen {
                                let mut h = health.lock().unwrap_or_else(|p| p.into_inner());
                                *h = RealtimeHealth::Unavailable;
                            }
                        } else if parsed.event == "postgres_changes" && is_subscribed_to_postgres {
                            match parsed.payload.get("ids").and_then(|v| v.as_array()) {
                                Some(arr) if !arr.is_empty() => {
                                    let mut all_valid = true;
                                    for id_val in arr {
                                        let id = id_val.as_i64().unwrap_or(-1);
                                        if !postgres_subscription_ids.contains(&id) {
                                            all_valid = false;
                                            break;
                                        }
                                    }
                                    if all_valid {
                                        let (generation, head) = if sync_protocol == 2 {
                                            head_hint_from_payload(&parsed.payload)
                                        } else {
                                            (None, None)
                                        };
                                        let _ = app.emit("sync://remote-change", RemoteChangeEvent {
                                            project_id: project_id.to_string(),
                                            generation,
                                            head,
                                        });
                                    } else {
                                        return SessionOutcome::Reconnect;
                                    }
                                }
                                _ => return SessionOutcome::Reconnect,
                            }
                        } else if parsed.event == "presence_state" {
                            presence_map.clear();
                            if let Some(obj) = parsed.payload.as_object() {
                                for (conn_key, val) in obj {
                                    if let Some(metas) = val.get("metas").and_then(|m| m.as_array()) {
                                        let mut metas_map = HashMap::new();
                                        for meta in metas {
                                            if let (Some(phx_ref), Some(coder), Some(part), Some(up)) = (
                                                meta.get("phx_ref").and_then(|s| s.as_str()),
                                                meta.get("coder_name").and_then(|s| s.as_str()),
                                                meta.get("participant_label").and_then(|s| s.as_str()),
                                                meta.get("updated_at").and_then(|s| s.as_str()),
                                            ) {
                                                metas_map.insert(phx_ref.to_string(), PresenceUser {
                                                    coder_name: coder.to_string(),
                                                    participant_label: part.to_string(),
                                                    updated_at: up.to_string(),
                                                });
                                            }
                                        }
                                        if !metas_map.is_empty() {
                                            presence_map.insert(conn_key.clone(), metas_map);
                                        }
                                    }
                                }
                            }
                            let active_list = flatten_presence(&presence_map, &local_conn_key);
                            let _ = app.emit("sync://presence-change", active_list);
                        } else if parsed.event == "presence_diff" {
                            if let Some(joins) = parsed.payload.get("joins").and_then(|v| v.as_object()) {
                                for (conn_key, val) in joins {
                                    if let Some(metas) = val.get("metas").and_then(|m| m.as_array()) {
                                        let metas_map = presence_map.entry(conn_key.clone()).or_default();
                                        for meta in metas {
                                            if let (Some(phx_ref), Some(coder), Some(part), Some(up)) = (
                                                meta.get("phx_ref").and_then(|s| s.as_str()),
                                                meta.get("coder_name").and_then(|s| s.as_str()),
                                                meta.get("participant_label").and_then(|s| s.as_str()),
                                                meta.get("updated_at").and_then(|s| s.as_str()),
                                            ) {
                                                metas_map.insert(phx_ref.to_string(), PresenceUser {
                                                    coder_name: coder.to_string(),
                                                    participant_label: part.to_string(),
                                                    updated_at: up.to_string(),
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                            if let Some(leaves) = parsed.payload.get("leaves").and_then(|v| v.as_object()) {
                                for (conn_key, val) in leaves {
                                    if let Some(metas) = val.get("metas").and_then(|m| m.as_array()) {
                                        if let Some(metas_map) = presence_map.get_mut(conn_key) {
                                            for meta in metas {
                                                if let Some(phx_ref) = meta.get("phx_ref").and_then(|s| s.as_str()) {
                                                    metas_map.remove(phx_ref);
                                                }
                                            }
                                        }
                                        if presence_map.get(conn_key).is_some_and(|m| m.is_empty()) {
                                            presence_map.remove(conn_key);
                                        }
                                    }
                                }
                            }
                            let active_list = flatten_presence(&presence_map, &local_conn_key);
                            let _ = app.emit("sync://presence-change", active_list);
                        } else if parsed.event == "phx_error" || parsed.event == "phx_close" {
                            return SessionOutcome::Reconnect;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                        return SessionOutcome::Reconnect;
                    }
                    _ => {}
                }
            }
        }
    }
}

// ── Unit Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_topic_format() {
        assert_eq!(channel_topic("proj-123"), "realtime:codemap:proj-123");
    }

    #[test]
    fn backoff_schedule_is_capped_and_jittered() {
        let b0 = compute_backoff(0);
        let b1 = compute_backoff(1);
        let b2 = compute_backoff(2);
        let b10 = compute_backoff(10);

        assert!(b0.as_secs() >= 1 && b0.as_secs() <= 2);
        assert!(b1.as_secs() >= 2 && b1.as_secs() <= 3);
        assert!(b2.as_secs() >= 4 && b2.as_secs() <= 5);
        assert!(b10.as_secs() <= 61, "Backoff capped at 60s + jitter");
    }

    #[test]
    fn event_payload_carries_only_project_id() {
        let ev = RemoteChangeEvent {
            project_id: "test-study-id".into(),
            generation: None,
            head: None,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(json, "{\"projectId\":\"test-study-id\"}");
        assert!(!json.contains("transcript"));
        assert!(!json.contains("code"));
    }

    #[test]
    fn v2_subscribes_only_to_project_heads() {
        let subscriptions = postgres_changes_config("project-1", 2);
        assert_eq!(subscriptions.len(), 1);
        assert_eq!(subscriptions[0]["table"], "sync_project_heads");
        assert_eq!(subscriptions[0]["filter"], "project_id=eq.project-1");
        assert_eq!(
            subscriptions[0]["select"],
            serde_json::json!(["project_id", "generation", "head_seq"])
        );
        assert!(!serde_json::to_string(&subscriptions)
            .unwrap()
            .contains("codebook"));
    }

    #[test]
    fn v1_retains_legacy_table_subscriptions_until_cutover() {
        let subscriptions = postgres_changes_config("project-1", 1);
        let tables = subscriptions
            .iter()
            .filter_map(|value| value.get("table").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(tables, vec!["coded_segments", "codebook", "interviews"]);
    }

    #[test]
    fn v2_head_hint_extracts_metadata_without_change_payload() {
        let (generation, head) = head_hint_from_payload(&serde_json::json!({
            "data": { "record": {
                "generation": "5f8f6a2c-3b9d-4d24-9a86-a9b9cb9a7b11",
                "head_seq": 42,
                "definition": "must never be read"
            }}
        }));
        assert_eq!(
            generation.as_deref(),
            Some("5f8f6a2c-3b9d-4d24-9a86-a9b9cb9a7b11")
        );
        assert_eq!(head, Some(42));
    }

    #[test]
    fn presence_payload_carries_no_free_text() {
        let p = PresenceUser {
            coder_name: "Ada".into(),
            participant_label: "P07".into(),
            updated_at: "2026-08-22T12:00:00Z".into(),
        };
        let json = serde_json::to_string(&p).unwrap();
        assert_eq!(
            json,
            "{\"coderName\":\"Ada\",\"participantLabel\":\"P07\",\"updatedAt\":\"2026-08-22T12:00:00Z\"}"
        );
        assert!(!json.contains("transcript"));
        assert!(!json.contains("rehearse"));
    }

    #[test]
    fn presence_flattening_and_deduplication() {
        let mut map: HashMap<String, HashMap<String, PresenceUser>> = HashMap::new();
        let local_key = "local-uuid";

        let mut local_metas = HashMap::new();
        local_metas.insert(
            "ref1".into(),
            PresenceUser {
                coder_name: "Ada".into(),
                participant_label: "P01".into(),
                updated_at: "2026-08-22T10:00:00Z".into(),
            },
        );
        map.insert(local_key.into(), local_metas);

        let mut remote1_metas = HashMap::new();
        remote1_metas.insert(
            "ref2".into(),
            PresenceUser {
                coder_name: "Alice".into(),
                participant_label: "P02".into(),
                updated_at: "2026-08-22T10:01:00Z".into(),
            },
        );
        map.insert("remote-conn-1".into(), remote1_metas);

        let mut remote2_metas = HashMap::new();
        remote2_metas.insert(
            "ref3".into(),
            PresenceUser {
                coder_name: "Alice".into(),
                participant_label: "P03".into(),
                updated_at: "2026-08-22T10:02:00Z".into(),
            },
        );
        map.insert("remote-conn-2".into(), remote2_metas);

        let list = flatten_presence(&map, local_key);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].coder_name, "Alice");
    }

    #[test]
    fn presence_partial_and_final_leave() {
        let mut map: HashMap<String, HashMap<String, PresenceUser>> = HashMap::new();
        let conn_key = "conn-1";

        let mut metas = HashMap::new();
        metas.insert(
            "ref1".into(),
            PresenceUser {
                coder_name: "Bob".into(),
                participant_label: "P01".into(),
                updated_at: "2026-08-22T10:00:00Z".into(),
            },
        );
        metas.insert(
            "ref2".into(),
            PresenceUser {
                coder_name: "Bob".into(),
                participant_label: "P02".into(),
                updated_at: "2026-08-22T10:01:00Z".into(),
            },
        );
        map.insert(conn_key.into(), metas);

        // Partial leave: remove ref1
        map.get_mut(conn_key).unwrap().remove("ref1");
        assert_eq!(flatten_presence(&map, "other").len(), 1);

        // Final leave: remove ref2 and clean key
        map.get_mut(conn_key).unwrap().remove("ref2");
        if map.get(conn_key).is_some_and(|m| m.is_empty()) {
            map.remove(conn_key);
        }
        assert_eq!(flatten_presence(&map, "other").len(), 0);
    }

    #[test]
    fn start_can_be_called_without_tokio_runtime() {
        let app = tauri::test::mock_app();
        let manager = RealtimeManager::new();
        manager.start(
            app.handle().clone(),
            "ws://127.0.0.1:0".into(),
            "anon_key".into(),
            "token".into(),
            "proj-1".into(),
            "Ada".into(),
            1,
        );
        manager.stop(app.handle());
    }

    #[tokio::test]
    async fn realtime_liveness_and_protocol_lifecycle() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = tauri::test::mock_app();
        let manager = RealtimeManager::new();

        manager.start(
            app.handle().clone(),
            format!("http://127.0.0.1:{port}"),
            "anon-key".into(),
            "test-token".into(),
            "proj-123".into(),
            "Tester".into(),
            1,
        );

        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();

        // 1. Validate join frame
        let msg = ws.next().await.unwrap().unwrap();
        let text = msg.to_text().unwrap();
        let join_msg: PhoenixMessage = serde_json::from_str(text).unwrap();
        assert_eq!(join_msg.event, "phx_join");
        assert_eq!(join_msg.topic, "realtime:codemap:proj-123");
        assert_eq!(join_msg.join_ref, join_msg.r#ref);
        let join_ref = join_msg.join_ref.clone().unwrap();

        let cfg = join_msg.payload.get("config").unwrap();
        assert_eq!(cfg.get("presence").unwrap().get("enabled").unwrap(), true);
        let pg_changes = cfg.get("postgres_changes").unwrap().as_array().unwrap();
        assert_eq!(pg_changes.len(), 3);
        assert_eq!(
            join_msg
                .payload
                .get("access_token")
                .unwrap()
                .as_str()
                .unwrap(),
            "test-token"
        );

        // 2. Server sends join reply (status ok)
        let reply = serde_json::json!({
            "topic": "realtime:codemap:proj-123",
            "event": "phx_reply",
            "payload": {
                "status": "ok",
                "response": {
                    "postgres_changes": [
                        { "id": 101 },
                        { "id": 102 },
                        { "id": 103 }
                    ]
                }
            },
            "ref": join_ref,
            "join_ref": join_ref
        });
        ws.send(Message::Text(serde_json::to_string(&reply).unwrap().into()))
            .await
            .unwrap();

        // Connected should NOT be true yet
        assert_ne!(manager.health(), RealtimeHealth::Connected);

        // 3. Server sends system subscription success
        let system_msg = serde_json::json!({
            "topic": "realtime:codemap:proj-123",
            "event": "system",
            "payload": {
                "extension": "postgres_changes",
                "status": "ok",
                "message": "Subscribed to PostgreSQL"
            },
            "ref": null,
            "join_ref": join_ref
        });
        ws.send(Message::Text(
            serde_json::to_string(&system_msg).unwrap().into(),
        ))
        .await
        .unwrap();

        // 4. Assert is_connected becomes true and stays true
        for _ in 0..40 {
            if manager.is_connected() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(manager.is_connected());
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(manager.is_connected());

        // 5. Assert Presence track frame arrives
        let track_frame = ws.next().await.unwrap().unwrap();
        let track_msg: PhoenixMessage =
            serde_json::from_str(track_frame.to_text().unwrap()).unwrap();
        assert_eq!(track_msg.event, "presence");
        assert_eq!(track_msg.topic, "realtime:codemap:proj-123");
        assert_eq!(track_msg.join_ref.as_deref(), Some(join_ref.as_str()));
        assert_eq!(
            track_msg
                .payload
                .get("payload")
                .unwrap()
                .get("coder_name")
                .unwrap()
                .as_str()
                .unwrap(),
            "Tester"
        );

        // 6. Assert heartbeat frame arrives
        let hb_frame = ws.next().await.unwrap().unwrap();
        let hb_msg: PhoenixMessage = serde_json::from_str(hb_frame.to_text().unwrap()).unwrap();
        assert_eq!(hb_msg.event, "heartbeat");
        assert_eq!(hb_msg.topic, "phoenix");
        assert!(hb_msg.join_ref.is_none());
        assert!(hb_msg.r#ref.is_some());

        // 7. Send valid postgres_changes
        let pg_msg = serde_json::json!({
            "topic": "realtime:codemap:proj-123",
            "event": "postgres_changes",
            "payload": {
                "ids": [101],
                "data": { "record": { "id": "seg-1" } }
            },
            "ref": null,
            "join_ref": join_ref
        });
        ws.send(Message::Text(
            serde_json::to_string(&pg_msg).unwrap().into(),
        ))
        .await
        .unwrap();

        // 8. Stop manager and verify cleanup
        manager.stop(app.handle());
        assert_eq!(manager.health(), RealtimeHealth::Off);
    }

    #[tokio::test]
    async fn realtime_system_error_produces_unavailable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = tauri::test::mock_app();
        let manager = RealtimeManager::new();

        manager.start(
            app.handle().clone(),
            format!("http://127.0.0.1:{port}"),
            "anon-key".into(),
            "test-token".into(),
            "proj-123".into(),
            "Tester".into(),
            1,
        );

        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();

        let msg = ws.next().await.unwrap().unwrap();
        let join_msg: PhoenixMessage = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        let join_ref = join_msg.join_ref.unwrap();

        let reply = serde_json::json!({
            "topic": "realtime:codemap:proj-123",
            "event": "phx_reply",
            "payload": { "status": "ok", "response": { "postgres_changes": [{ "id": 1 }] } },
            "ref": join_ref,
            "join_ref": join_ref
        });
        ws.send(Message::Text(serde_json::to_string(&reply).unwrap().into()))
            .await
            .unwrap();

        let sys_err = serde_json::json!({
            "topic": "realtime:codemap:proj-123",
            "event": "system",
            "payload": {
                "extension": "postgres_changes",
                "status": "error",
                "message": "Subscription failed"
            },
            "ref": null,
            "join_ref": join_ref
        });
        ws.send(Message::Text(
            serde_json::to_string(&sys_err).unwrap().into(),
        ))
        .await
        .unwrap();

        for _ in 0..20 {
            if manager.health() == RealtimeHealth::Unavailable {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(manager.health(), RealtimeHealth::Unavailable);
        assert!(!manager.is_connected());

        manager.stop(app.handle());
    }

    #[tokio::test]
    async fn realtime_stop_during_backoff_exits_promptly() {
        let app = tauri::test::mock_app();
        let manager = RealtimeManager::new();

        manager.start(
            app.handle().clone(),
            "http://127.0.0.1:1".into(),
            "anon-key".into(),
            "test-token".into(),
            "proj-123".into(),
            "Tester".into(),
            1,
        );

        tokio::time::sleep(Duration::from_millis(100)).await;

        let start_time = std::time::Instant::now();
        manager.stop(app.handle());
        let elapsed = start_time.elapsed();

        assert!(
            elapsed < Duration::from_millis(250),
            "stop() took {:?}, expected < 250ms",
            elapsed
        );
        assert_eq!(manager.health(), RealtimeHealth::Off);
    }
}
