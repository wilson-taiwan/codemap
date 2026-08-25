use crate::backup;
use crate::commands::{AppState, SyncRunTarget};
use crate::db::{self, V2IncomingChange, V2IncomingConflict, V2OutboxOperation};
use crate::sync::{self, RpcArg, RpcSpec, SyncConfig, SyncError, SyncOutcome, SyncSession};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

const MAX_WIRE_BYTES: usize = 5 * 1024 * 1024;
const MAX_OPERATION_BYTES: usize = 64 * 1024;
const APPLY_LIMIT: usize = 200;
const PULL_LIMIT: i64 = 500;

const RPC_REGISTER_DEVICE: RpcSpec = RpcSpec {
    name: "sync_v2_register_device",
    args: &[
        RpcArg {
            name: "project_id",
            sql_type: "text",
        },
        RpcArg {
            name: "device_id",
            sql_type: "uuid",
        },
        RpcArg {
            name: "client_version",
            sql_type: "text",
        },
        RpcArg {
            name: "max_protocol",
            sql_type: "integer",
        },
        RpcArg {
            name: "local_schema_version",
            sql_type: "integer",
        },
        RpcArg {
            name: "legacy_pending_count",
            sql_type: "integer",
        },
    ],
};

const RPC_APPLY: RpcSpec = RpcSpec {
    name: "sync_v2_apply",
    args: &[
        RpcArg {
            name: "project_id",
            sql_type: "text",
        },
        RpcArg {
            name: "generation",
            sql_type: "uuid",
        },
        RpcArg {
            name: "device_id",
            sql_type: "uuid",
        },
        RpcArg {
            name: "operations",
            sql_type: "jsonb",
        },
    ],
};

const RPC_PULL: RpcSpec = RpcSpec {
    name: "sync_v2_pull",
    args: &[
        RpcArg {
            name: "project_id",
            sql_type: "text",
        },
        RpcArg {
            name: "generation",
            sql_type: "uuid",
        },
        RpcArg {
            name: "after_seq",
            sql_type: "bigint",
        },
        RpcArg {
            name: "limit_count",
            sql_type: "integer",
        },
    ],
};

const RPC_SNAPSHOT: RpcSpec = RpcSpec {
    name: "sync_v2_snapshot",
    args: &[
        RpcArg {
            name: "project_id",
            sql_type: "text",
        },
        RpcArg {
            name: "generation",
            sql_type: "uuid",
        },
    ],
};

const RPC_READINESS: RpcSpec = RpcSpec {
    name: "sync_v2_readiness",
    args: &[RpcArg {
        name: "project_id",
        sql_type: "text",
    }],
};

const RPC_ACTIVATE: RpcSpec = RpcSpec {
    name: "sync_v2_activate",
    args: &[RpcArg {
        name: "project_id",
        sql_type: "text",
    }],
};

pub(crate) const RPC_RESOLVE_CONFLICT: RpcSpec = RpcSpec {
    name: "sync_v2_resolve_conflict",
    args: &[
        RpcArg {
            name: "conflict_id",
            sql_type: "uuid",
        },
        RpcArg {
            name: "resolution",
            sql_type: "text",
        },
        RpcArg {
            name: "custom_value",
            sql_type: "jsonb",
        },
    ],
};

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Registration {
    pub protocol: i64,
    pub generation: Option<String>,
    pub head: i64,
    pub ready: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyReceipt {
    op_id: String,
    status: String,
    first_seq: i64,
    last_seq: i64,
    conflict_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyResponse {
    generation: String,
    head: i64,
    receipts: Vec<ApplyReceipt>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireChange {
    seq: i64,
    op_id: String,
    device_id: Option<String>,
    user_id: Option<String>,
    actor_key: String,
    entity_type: String,
    entity_id: String,
    op_kind: String,
    payload: serde_json::Value,
    created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireConflict {
    conflict_id: String,
    entity_type: String,
    entity_id: String,
    field_name: String,
    current_value: serde_json::Value,
    proposed_value: serde_json::Value,
    base_value: Option<serde_json::Value>,
    originating_op_id: String,
    #[serde(default)]
    proposer_label: Option<String>,
    status: String,
    created_at: String,
    resolved_seq: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PullResponse {
    generation: String,
    head: i64,
    changes: Vec<WireChange>,
    conflicts: Vec<WireConflict>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotResponse {
    replay_required: bool,
    generation: String,
    snapshot_seq: i64,
    #[serde(default)]
    codes: Vec<serde_json::Value>,
    #[serde(default)]
    interviews: Vec<serde_json::Value>,
    #[serde(default)]
    assignments: Vec<serde_json::Value>,
    #[serde(default)]
    conflicts: Vec<WireConflict>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireReadinessMember {
    user_id: String,
    coder_name: String,
    role: String,
    ready: bool,
    ready_at: Option<String>,
    last_device_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireReadiness {
    protocol: i64,
    generation: Option<String>,
    head: i64,
    members: Vec<WireReadinessMember>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadinessMember {
    pub user_id: String,
    pub coder_name: String,
    pub role: String,
    pub ready: bool,
    pub ready_at: Option<String>,
    pub last_device_id_suffix: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Readiness {
    pub protocol: i64,
    pub generation_suffix: Option<String>,
    pub head: i64,
    pub members: Vec<ReadinessMember>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireActivation {
    protocol: i64,
    generation: String,
    head: i64,
    legacy_actor_rows: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Activation {
    pub protocol: i64,
    pub generation_suffix: String,
    pub head: i64,
    pub legacy_actor_rows: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
struct WireOperation {
    op_id: String,
    client_seq: i64,
    entity_type: String,
    entity_id: String,
    op_kind: String,
    payload: serde_json::Value,
    base_field_versions: serde_json::Value,
}

fn public_wire_error(message: &str) -> SyncError {
    SyncError::Db(message.to_string())
}

fn object_has_only(value: &serde_json::Value, allowed: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str())))
}

fn validate_payload(op_kind: &str, payload: &serde_json::Value) -> Result<(), SyncError> {
    if serde_json::to_vec(payload)
        .map_err(|_| public_wire_error("Could not encode Sync Protocol 2 data."))?
        .len()
        > MAX_OPERATION_BYTES
    {
        return Err(public_wire_error(
            "A Sync Protocol 2 operation is too large.",
        ));
    }
    let forbidden = [
        "memo",
        "transcript",
        "segment_text",
        "text",
        "quote_text",
        "diagnosis",
        "audio_path",
        "raw_vtt_path",
        "path",
        "filename",
        "email",
        "token",
        "url",
    ];
    if payload
        .as_object()
        .is_some_and(|object| object.keys().any(|key| forbidden.contains(&key.as_str())))
    {
        return Err(public_wire_error(
            "Sync Protocol 2 payload violates the privacy allowlist.",
        ));
    }
    let valid = match op_kind {
        "code.create" => object_has_only(
            payload,
            &[
                "name",
                "definition",
                "inclusion_criteria",
                "exclusion_criteria",
                "example",
                "parent_id",
                "color",
                "sort_order",
                "is_retired",
                "deleted",
            ],
        ),
        "code.patch" => {
            object_has_only(payload, &["patch"])
                && payload.get("patch").is_some_and(|patch| {
                    object_has_only(
                        patch,
                        &[
                            "name",
                            "definition",
                            "inclusion_criteria",
                            "exclusion_criteria",
                            "example",
                            "parent_id",
                            "color",
                            "sort_order",
                            "is_retired",
                            "deleted",
                        ],
                    )
                })
        }
        "interview.patch" => {
            object_has_only(payload, &["patch"])
                && payload.get("patch").is_some_and(|patch| {
                    object_has_only(
                        patch,
                        &["study_label", "segment_count", "content_hash", "deleted"],
                    )
                })
        }
        "code.retire" | "code.purge" => object_has_only(payload, &[]),
        "coding.patch" => {
            object_has_only(payload, &["adds", "removes"])
                && ["adds", "removes"].into_iter().all(|key| {
                    payload.get(key).is_some_and(|edges| {
                        edges.as_array().is_some_and(|edges| {
                            edges.iter().all(|edge| {
                                object_has_only(
                                    edge,
                                    &[
                                        "interview_id",
                                        "segment_id",
                                        "code_id",
                                        "char_start",
                                        "char_end",
                                    ],
                                )
                            })
                        })
                    })
                })
        }
        "conflict.resolve" => {
            object_has_only(payload, &["conflict_id", "resolution", "value"])
                && payload
                    .get("conflict_id")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| value.len() == 36)
                && payload
                    .get("resolution")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|value| {
                        matches!(value, "keep_current" | "accept_proposal" | "custom")
                    })
                && payload.get("value").is_some()
        }
        _ => false,
    };
    valid.then_some(()).ok_or_else(|| {
        public_wire_error("Sync Protocol 2 operation has an invalid allowlisted shape.")
    })
}

fn to_wire_operation(operation: &V2OutboxOperation) -> Result<WireOperation, SyncError> {
    if operation.op_id.len() != 36
        || operation.entity_id.len() > 200
        || !operation.base_field_versions.is_object()
    {
        return Err(public_wire_error(
            "Local Sync Protocol 2 metadata is invalid.",
        ));
    }
    validate_payload(&operation.op_kind, &operation.payload)?;
    Ok(WireOperation {
        op_id: operation.op_id.clone(),
        client_seq: operation.client_seq,
        entity_type: operation.entity_type.clone(),
        entity_id: operation.entity_id.clone(),
        op_kind: operation.op_kind.clone(),
        payload: operation.payload.clone(),
        base_field_versions: operation.base_field_versions.clone(),
    })
}

fn to_change(change: WireChange) -> Result<V2IncomingChange, SyncError> {
    if change.seq < 1 || change.op_id.len() != 36 || change.entity_id.len() > 200 {
        return Err(public_wire_error(
            "Server returned invalid Sync Protocol 2 change metadata.",
        ));
    }
    if change.device_id.as_deref().is_some_and(|id| id.len() != 36)
        || change.user_id.as_deref().is_some_and(|id| id.len() != 36)
    {
        return Err(public_wire_error(
            "Server returned invalid Sync Protocol 2 actor metadata.",
        ));
    }
    validate_payload(&change.op_kind, &change.payload)?;
    Ok(V2IncomingChange {
        seq: change.seq,
        op_id: change.op_id,
        actor_key: change.actor_key,
        entity_type: change.entity_type,
        entity_id: change.entity_id,
        op_kind: change.op_kind,
        payload: change.payload,
        created_at: change.created_at,
    })
}

fn to_conflict(conflict: WireConflict) -> Result<V2IncomingConflict, SyncError> {
    if conflict.conflict_id.len() != 36
        || conflict.originating_op_id.len() != 36
        || conflict.entity_id.len() > 200
        || conflict.field_name.len() > 100
        || conflict
            .proposer_label
            .as_deref()
            .is_some_and(|label| label.len() > 200)
        || !matches!(conflict.status.as_str(), "unresolved" | "resolved")
    {
        return Err(public_wire_error(
            "Server returned invalid Sync Protocol 2 conflict metadata.",
        ));
    }
    Ok(V2IncomingConflict {
        conflict_id: conflict.conflict_id,
        entity_type: conflict.entity_type,
        entity_id: conflict.entity_id,
        field_name: conflict.field_name,
        current_value: conflict.current_value,
        proposed_value: conflict.proposed_value,
        base_value: conflict.base_value,
        originating_op_id: conflict.originating_op_id,
        proposer_label: conflict.proposer_label,
        status: conflict.status,
        created_at: conflict.created_at,
        resolved_seq: conflict.resolved_seq,
    })
}

async fn rpc_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    spec: &'static RpcSpec,
    body: serde_json::Value,
) -> Result<T, SyncError> {
    let response = sync::rpc_request(client, cfg, Some(session), spec, body).await?;
    if !response.status().is_success() {
        return Err(sync::rpc_failure(response, spec).await);
    }
    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_WIRE_BYTES)
    {
        return Err(public_wire_error(
            "Sync Protocol 2 server response is too large.",
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| SyncError::Network(error.to_string()))?;
    if bytes.len() > MAX_WIRE_BYTES {
        return Err(public_wire_error(
            "Sync Protocol 2 server response is too large.",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| public_wire_error("Sync Protocol 2 server response is invalid."))
}

async fn rpc_json_with_refresh<T: DeserializeOwned>(
    app: &tauri::AppHandle,
    state: &AppState,
    client: &reqwest::Client,
    cfg: &SyncConfig,
    session: &mut SyncSession,
    spec: &'static RpcSpec,
    body: serde_json::Value,
) -> Result<T, SyncError> {
    match rpc_json(client, cfg, session, spec, body.clone()).await {
        Err(SyncError::Unauthorized) => {
            let renewed = sync::refresh(client, cfg, session).await?;
            state.update_sync_session(app, renewed.clone())?;
            *session = renewed;
            rpc_json(client, cfg, session, spec, body).await
        }
        outcome => outcome,
    }
}

pub(crate) async fn register_device(
    app: &tauri::AppHandle,
    state: &AppState,
    target: &SyncRunTarget,
    client: &reqwest::Client,
    cfg: &SyncConfig,
) -> Result<Registration, SyncError> {
    let (local, local_schema_version, legacy_pending_count) = state
        .with_sync_target(target, |conn| {
            Ok((
                db::v2_local_state(conn).map_err(|error| error.to_string())?,
                db::local_schema_version(conn).map_err(|error| error.to_string())?,
                db::v2_legacy_pending_count(conn).map_err(|error| error.to_string())?,
            ))
        })
        .map_err(SyncError::Db)?;
    let mut session = state.sync_session().map_err(SyncError::Db)?;
    let registration: Registration = rpc_json_with_refresh(
        app,
        state,
        client,
        cfg,
        &mut session,
        &RPC_REGISTER_DEVICE,
        serde_json::json!({
            "project_id": local.project_id,
            "device_id": local.device_id,
            "client_version": env!("CARGO_PKG_VERSION"),
            "max_protocol": 2,
            "local_schema_version": local_schema_version,
            "legacy_pending_count": legacy_pending_count,
        }),
    )
    .await?;
    if !matches!(registration.protocol, 1 | 2) || registration.head < 0 {
        return Err(public_wire_error(
            "Server returned an invalid Sync Protocol version.",
        ));
    }
    let actor_key = (!session.user_id.is_empty()).then(|| format!("user:{}", session.user_id));
    state
        .with_sync_target(target, |conn| {
            db::record_v2_registration(
                conn,
                registration.protocol,
                registration.generation.as_deref(),
                registration.head,
                actor_key.as_deref(),
            )
            .map_err(|error| error.to_string())
        })
        .map_err(SyncError::Db)?;
    Ok(registration)
}

async fn apply_outbox(
    app: &tauri::AppHandle,
    state: &AppState,
    target: &SyncRunTarget,
    client: &reqwest::Client,
    cfg: &SyncConfig,
    generation: &str,
) -> Result<(usize, i64), SyncError> {
    let (local, operations) = state
        .with_sync_target(target, |conn| {
            Ok((
                db::v2_local_state(conn).map_err(|error| error.to_string())?,
                db::list_v2_outbox(conn, APPLY_LIMIT).map_err(|error| error.to_string())?,
            ))
        })
        .map_err(SyncError::Db)?;
    if operations.is_empty() {
        return Ok((0, local.observed_head));
    }
    if local.protocol != 2
        || operations.iter().any(|operation| {
            operation.generation != generation
                || operation.device_id != local.device_id
                || operation.project_id != local.project_id
        })
    {
        return Err(public_wire_error(
            "Local Sync Protocol 2 outbox belongs to a different generation or device.",
        ));
    }
    let wire_operations = operations
        .iter()
        .map(to_wire_operation)
        .collect::<Result<Vec<_>, _>>()?;
    let mut session = state.sync_session().map_err(SyncError::Db)?;
    let result: ApplyResponse = match rpc_json_with_refresh(
        app,
        state,
        client,
        cfg,
        &mut session,
        &RPC_APPLY,
        serde_json::json!({
            "project_id": local.project_id,
            "generation": generation,
            "device_id": local.device_id,
            "operations": wire_operations,
        }),
    )
    .await
    {
        Ok(result) => result,
        Err(error) => {
            let ids = operations
                .iter()
                .map(|operation| operation.op_id.clone())
                .collect::<Vec<_>>();
            let public_reason = matches!(&error, SyncError::ServerRejected { .. })
                .then_some("server rejected operation");
            let _ = state.with_sync_target(target, |conn| {
                db::note_v2_outbox_attempt(conn, &ids, public_reason)
                    .map_err(|cause| cause.to_string())
            });
            return Err(error);
        }
    };
    if result.generation != generation
        || result.head < 0
        || result.receipts.len() != operations.len()
    {
        return Err(public_wire_error(
            "Server returned an invalid Sync Protocol 2 apply receipt.",
        ));
    }
    let expected_ids = operations
        .iter()
        .map(|operation| operation.op_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut receipts = Vec::with_capacity(result.receipts.len());
    for receipt in result.receipts {
        if !expected_ids.contains(receipt.op_id.as_str())
            || !matches!(
                receipt.status.as_str(),
                "applied" | "conflicted" | "blocked" | "rejected"
            )
            || receipt.first_seq < 0
            || receipt.last_seq < receipt.first_seq
            || receipt.conflict_ids.iter().any(|id| id.len() != 36)
        {
            return Err(public_wire_error(
                "Server returned an invalid Sync Protocol 2 apply receipt.",
            ));
        }
        receipts.push((receipt.op_id, receipt.status));
    }
    state
        .with_sync_target(target, |conn| {
            db::complete_v2_outbox_receipts(conn, &receipts, result.head)
                .map_err(|error| error.to_string())
        })
        .map_err(SyncError::Db)?;
    Ok((receipts.len(), result.head))
}

async fn pull_to_head(
    app: &tauri::AppHandle,
    state: &AppState,
    target: &SyncRunTarget,
    client: &reqwest::Client,
    cfg: &SyncConfig,
    generation: &str,
) -> Result<(usize, i64), SyncError> {
    let mut pulled = 0usize;
    loop {
        let local = state
            .with_sync_target(target, |conn| {
                db::v2_local_state(conn).map_err(|error| error.to_string())
            })
            .map_err(SyncError::Db)?;
        let mut session = state.sync_session().map_err(SyncError::Db)?;
        let response: PullResponse = rpc_json_with_refresh(
            app,
            state,
            client,
            cfg,
            &mut session,
            &RPC_PULL,
            serde_json::json!({
                "project_id": local.project_id,
                "generation": generation,
                "after_seq": local.server_seq,
                "limit_count": PULL_LIMIT,
            }),
        )
        .await?;
        if response.generation != generation || response.head < local.server_seq {
            return Err(public_wire_error(
                "Sync Protocol 2 generation or head changed during pull.",
            ));
        }
        let changes = response
            .changes
            .into_iter()
            .map(to_change)
            .collect::<Result<Vec<_>, _>>()?;
        let conflicts = response
            .conflicts
            .into_iter()
            .map(to_conflict)
            .collect::<Result<Vec<_>, _>>()?;
        if changes.is_empty() {
            state
                .with_sync_target(target, |conn| {
                    db::apply_v2_pull_page(
                        conn,
                        &local.project_id,
                        generation,
                        local.server_seq,
                        response.head,
                        &[],
                        &conflicts,
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
                })
                .map_err(SyncError::Db)?;
            if local.server_seq != response.head {
                return Err(public_wire_error(
                    "Sync Protocol 2 pull returned a sequence gap; repair is required.",
                ));
            }
            return Ok((pulled, response.head));
        }
        let expected = local.server_seq + 1;
        if changes.first().is_none_or(|change| change.seq != expected) {
            return Err(public_wire_error(
                "Sync Protocol 2 pull returned a sequence gap; repair is required.",
            ));
        }
        let advanced = state
            .with_sync_target(target, |conn| {
                db::apply_v2_pull_page(
                    conn,
                    &local.project_id,
                    generation,
                    local.server_seq,
                    response.head,
                    &changes,
                    &conflicts,
                )
                .map_err(|error| error.to_string())
            })
            .map_err(SyncError::Db)?;
        pulled += changes.len();
        if advanced == response.head {
            return Ok((pulled, response.head));
        }
    }
}

async fn request_snapshot(
    app: &tauri::AppHandle,
    state: &AppState,
    client: &reqwest::Client,
    cfg: &SyncConfig,
    project_id: &str,
    generation: &str,
) -> Result<SnapshotResponse, SyncError> {
    let mut session = state.sync_session().map_err(SyncError::Db)?;
    let snapshot: SnapshotResponse = rpc_json_with_refresh(
        app,
        state,
        client,
        cfg,
        &mut session,
        &RPC_SNAPSHOT,
        serde_json::json!({ "project_id": project_id, "generation": generation }),
    )
    .await?;
    if snapshot.generation != generation || snapshot.snapshot_seq < 0 {
        return Err(public_wire_error(
            "Sync Protocol 2 snapshot has invalid generation metadata.",
        ));
    }
    if !snapshot.replay_required
        && (snapshot.codes.len() + snapshot.interviews.len() + snapshot.assignments.len()
            > 1_000_000)
    {
        return Err(public_wire_error(
            "Sync Protocol 2 snapshot exceeds the local safety limit.",
        ));
    }
    Ok(snapshot)
}

async fn repair_by_replay(
    app: &tauri::AppHandle,
    state: &AppState,
    target: &SyncRunTarget,
    client: &reqwest::Client,
    cfg: &SyncConfig,
    generation: &str,
) -> Result<(usize, i64), SyncError> {
    let local = state
        .with_sync_target(target, |conn| {
            db::v2_local_state(conn).map_err(|error| error.to_string())
        })
        .map_err(SyncError::Db)?;
    let snapshot = request_snapshot(app, state, client, cfg, &local.project_id, generation).await?;
    let expected_outbox_count = state
        .with_sync_target(target, |conn| {
            conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| error.to_string())
        })
        .map_err(SyncError::Db)?;
    let backup = state
        .snapshot_open_project(
            backup::BackupReason::Automatic,
            Some("sync-v2-repair".into()),
        )
        .map_err(SyncError::Db)?;
    let minimum_code_count = snapshot.codes.len();
    let minimum_interview_count = snapshot.interviews.len();
    let repair = async {
        if snapshot.replay_required {
            state
                .with_sync_target(target, |conn| {
                    db::reset_v2_synced_projection(conn).map_err(|error| error.to_string())
                })
                .map_err(SyncError::Db)?;
        } else {
            let conflicts = snapshot
                .conflicts
                .iter()
                .cloned()
                .map(to_conflict)
                .collect::<Result<Vec<_>, _>>()?;
            state
                .with_sync_target(target, |conn| {
                    db::rebuild_v2_snapshot(
                        conn,
                        &local.project_id,
                        generation,
                        snapshot.snapshot_seq,
                        &snapshot.codes,
                        &snapshot.interviews,
                        &snapshot.assignments,
                        &conflicts,
                    )
                    .map_err(|error| error.to_string())
                })
                .map_err(SyncError::Db)?;
        }
        let result = pull_to_head(app, state, target, client, cfg, generation).await?;
        state
            .with_sync_target(target, |conn| {
                db::verify_v2_repair_state(
                    conn,
                    result.1,
                    minimum_code_count,
                    minimum_interview_count,
                    expected_outbox_count,
                )
                .map_err(|error| error.to_string())
            })
            .map_err(SyncError::Db)?;
        Ok::<_, SyncError>(result)
    }
    .await;
    match repair {
        Ok(result) => Ok(result),
        Err(_) => match state.restore_sync_repair_backup(std::path::Path::new(&backup.path)) {
            Ok(()) => Err(public_wire_error(
                "Sync Protocol 2 repair failed; the automatic local backup was restored.",
            )),
            Err(_) => Err(public_wire_error(
                "Sync Protocol 2 repair failed and the automatic local backup needs attention.",
            )),
        },
    }
}

pub(crate) async fn run_registered(
    app: &tauri::AppHandle,
    state: &AppState,
    target: &SyncRunTarget,
    client: &reqwest::Client,
    cfg: &SyncConfig,
    registration: Registration,
    force_repair: bool,
) -> Result<SyncOutcome, String> {
    let generation = registration
        .generation
        .as_deref()
        .filter(|generation| !generation.is_empty())
        .ok_or("Sync Protocol 2 server did not return a generation.")?;
    let local = state.with_sync_target(target, |conn| {
        db::v2_local_state(conn).map_err(|error| error.to_string())
    })?;
    let mut pulled = 0usize;
    let mut head = registration.head;
    if force_repair || local.generation.as_deref() != Some(generation) || local.server_seq > head {
        let (repaired, repaired_head) =
            repair_by_replay(app, state, target, client, cfg, generation)
                .await
                .map_err(|error| error.to_string())?;
        pulled += repaired;
        head = repaired_head;
    }
    let _ready_for_cutover = registration.ready;
    let _actor_is_registered = local
        .actor_key
        .as_deref()
        .is_some_and(|actor| actor.starts_with("user:"));
    let (pushed, applied_head) = apply_outbox(app, state, target, client, cfg, generation)
        .await
        .map_err(|error| error.to_string())?;
    head = head.max(applied_head);
    match pull_to_head(app, state, target, client, cfg, generation).await {
        Ok((count, pulled_head)) => {
            pulled += count;
            head = head.max(pulled_head);
        }
        Err(error) => {
            let (count, repaired_head) =
                repair_by_replay(app, state, target, client, cfg, generation)
                    .await
                    .map_err(|repair_error| format!("{error}; repair failed: {repair_error}"))?;
            pulled += count;
            head = head.max(repaired_head);
        }
    }
    let final_state = state.with_sync_target(target, |conn| {
        db::v2_local_state(conn).map_err(|error| error.to_string())
    })?;
    if final_state.server_seq != head {
        return Err("Sync Protocol 2 did not reach the authoritative project head.".into());
    }
    let synced_at = db::now_iso();
    state.with_sync_target(target, |conn| {
        db::set_sync_state_value(conn, "sync_last_success_at", &synced_at)
            .map_err(|error| error.to_string())
    })?;
    Ok(SyncOutcome {
        pushed_codes: pushed,
        pulled_codes: pulled,
        pulled_interviews: pulled,
        synced_at,
        ..SyncOutcome::default()
    })
}

fn suffix(value: &str) -> String {
    value
        .chars()
        .rev()
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

pub(crate) async fn readiness(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<Readiness, String> {
    let cfg = state.project_sync_config(app)?;
    let client = sync::client().map_err(|error| error.to_string())?;
    let mut session = state.sync_session()?;
    let response: WireReadiness = rpc_json_with_refresh(
        app,
        state,
        &client,
        &cfg,
        &mut session,
        &RPC_READINESS,
        serde_json::json!({ "project_id": cfg.project_id }),
    )
    .await
    .map_err(|error| error.to_string())?;
    if !matches!(response.protocol, 1 | 2) || response.head < 0 {
        return Err("Server returned invalid protocol readiness metadata.".into());
    }
    let members = response
        .members
        .into_iter()
        .map(|member| {
            if member.user_id.len() != 36 || member.coder_name.len() > 120 {
                return Err(
                    "Server returned invalid protocol readiness member metadata.".to_string(),
                );
            }
            Ok(ReadinessMember {
                user_id: member.user_id,
                coder_name: member.coder_name,
                role: member.role,
                ready: member.ready,
                ready_at: member.ready_at,
                last_device_id_suffix: member.last_device_id.as_deref().map(suffix),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Readiness {
        protocol: response.protocol,
        generation_suffix: response.generation.as_deref().map(suffix),
        head: response.head,
        members,
    })
}

pub(crate) async fn activate(
    app: &tauri::AppHandle,
    state: &AppState,
) -> Result<Activation, String> {
    let cfg = state.project_sync_config(app)?;
    let client = sync::client().map_err(|error| error.to_string())?;
    let mut session = state.sync_session()?;
    let response: WireActivation = rpc_json_with_refresh(
        app,
        state,
        &client,
        &cfg,
        &mut session,
        &RPC_ACTIVATE,
        serde_json::json!({ "project_id": cfg.project_id }),
    )
    .await
    .map_err(|error| error.to_string())?;
    if response.protocol != 2 || response.generation.len() != 36 || response.head < 0 {
        return Err("Server returned invalid protocol activation metadata.".into());
    }
    state.request_background_sync(app.clone(), crate::sync_coordinator::SyncTrigger::Manual);
    Ok(Activation {
        protocol: response.protocol,
        generation_suffix: suffix(&response.generation),
        head: response.head,
        legacy_actor_rows: response.legacy_actor_rows,
    })
}

pub(crate) async fn resolve_conflict(
    app: &tauri::AppHandle,
    state: &AppState,
    conflict_id: &str,
    resolution: &str,
    custom_value: Option<serde_json::Value>,
) -> Result<(), String> {
    if !matches!(resolution, "keep_current" | "accept_proposal" | "custom") {
        return Err("Choose keep current, use proposed, or a custom value.".into());
    }
    if resolution == "custom"
        && custom_value.as_ref().is_none_or(|value| {
            !value.is_string() && !value.is_number() && !value.is_boolean() && !value.is_null()
        })
    {
        return Err("A custom conflict resolution must be a single field value.".into());
    }
    let cfg = state.project_sync_config(app)?;
    let client = sync::client().map_err(|error| error.to_string())?;
    let mut session = state.sync_session()?;
    let _: serde_json::Value = rpc_json_with_refresh(
        app,
        state,
        &client,
        &cfg,
        &mut session,
        &RPC_RESOLVE_CONFLICT,
        serde_json::json!({
            "conflict_id": conflict_id,
            "resolution": resolution,
            "custom_value": custom_value,
        }),
    )
    .await
    .map_err(|error| error.to_string())?;
    state.request_background_sync(app.clone(), crate::sync_coordinator::SyncTrigger::Manual);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privacy_allowlist_rejects_local_content_keys() {
        for key in [
            "memo",
            "transcript",
            "segment_text",
            "text",
            "quote_text",
            "diagnosis",
            "audio_path",
            "raw_vtt_path",
            "path",
            "filename",
            "email",
            "token",
            "url",
        ] {
            let mut payload = serde_json::json!({ "name": "Synthetic" });
            payload
                .as_object_mut()
                .expect("synthetic payload is an object")
                .insert(key.into(), serde_json::Value::String("forbidden".into()));
            assert!(
                validate_payload("code.create", &payload).is_err(),
                "local-only key {key} was accepted"
            );
        }
        assert!(validate_payload(
            "code.patch",
            &serde_json::json!({ "patch": { "memo": "forbidden" } })
        )
        .is_err());
        assert!(validate_payload(
            "coding.patch",
            &serde_json::json!({ "adds": [{ "code_id": "code", "transcript": "forbidden" }], "removes": [] })
        )
        .is_err());
    }

    #[test]
    fn valid_v2_operation_has_no_timestamp_cursor() {
        let operation = V2OutboxOperation {
            op_id: "00000000-0000-4000-8000-000000000001".into(),
            project_id: "project".into(),
            generation: "00000000-0000-4000-8000-000000000002".into(),
            device_id: "00000000-0000-4000-8000-000000000003".into(),
            client_seq: 1,
            entity_type: "code".into(),
            entity_id: "code".into(),
            op_kind: "code.create".into(),
            payload: serde_json::json!({ "name": "Synthetic" }),
            base_field_versions: serde_json::json!({}),
        };
        let wire = to_wire_operation(&operation).unwrap();
        let encoded = serde_json::to_string(&wire).unwrap();
        assert!(!encoded.contains("updated_at"));
        assert!(!encoded.contains("cursor"));
    }
}
