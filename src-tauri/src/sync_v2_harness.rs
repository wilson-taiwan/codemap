#![cfg(test)]

use crate::db::{self, V2IncomingChange, V2IncomingConflict};
use crate::models::CreateCodeInput;
use rusqlite::Connection;
use std::fmt::Write;

fn connection() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    db::init_schema(&conn).unwrap();
    db::set_sync_state_value(&conn, "project_id", "project").unwrap();
    db::set_sync_state_value(
        &conn,
        "sync_device_id",
        "00000000-0000-4000-8000-000000000001",
    )
    .unwrap();
    db::set_sync_state_value(&conn, "sync_protocol", "2").unwrap();
    db::set_sync_state_value(
        &conn,
        "sync_generation",
        "00000000-0000-4000-8000-000000000002",
    )
    .unwrap();
    conn
}

fn code_change(seq: i64, id: &str) -> V2IncomingChange {
    V2IncomingChange {
        seq,
        op_id: format!("00000000-0000-4000-8000-{seq:012}"),
        actor_key: "user:00000000-0000-4000-8000-000000000003".into(),
        entity_type: "code".into(),
        entity_id: id.into(),
        op_kind: "code.create".into(),
        payload: serde_json::json!({ "name": format!("Synthetic {seq}") }),
        created_at: "2026-08-23T00:00:00Z".into(),
    }
}

fn model_change(
    seed: u64,
    seq: i64,
    actor_index: usize,
    entity_id: String,
    op_kind: &str,
    payload: serde_json::Value,
) -> V2IncomingChange {
    V2IncomingChange {
        seq,
        op_id: format!("00000000-0000-4000-{seed:04x}-{seq:012x}"),
        actor_key: format!("user:synthetic-actor-{actor_index}"),
        entity_type: "code".into(),
        entity_id,
        op_kind: op_kind.into(),
        payload,
        created_at: format!("2026-08-23T00:{:02}:{:02}Z", seq / 60, seq % 60),
    }
}

fn projection(conn: &Connection) -> Vec<(String, String, String, i64, i64)> {
    conn.prepare(
        "SELECT id, name, color, is_retired, deleted
           FROM codebook ORDER BY id",
    )
    .unwrap()
    .query_map([], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        ))
    })
    .unwrap()
    .collect::<rusqlite::Result<Vec<_>>>()
    .unwrap()
}

/// Deterministic transport model for the v2 ordered operation log. A transport
/// can drop, duplicate, or reorder pages, but it cannot advance the local
/// sequence past a missing operation. The failure includes seed and trace so a
/// failing schedule is reproducible without recording any study content.
fn run_v2_model_seed(seed: u64) -> Result<(), String> {
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    let mut next = || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        state
    };
    let client_count = 2 + (next() % 4) as usize;
    let operation_count = 12 + (next() % 16) as usize;
    let mut known_codes = Vec::<String>::new();
    let mut changes = Vec::<V2IncomingChange>::new();
    let mut trace = String::new();

    for ordinal in 0..operation_count {
        let seq = (ordinal + 1) as i64;
        let actor = (next() as usize) % client_count;
        let choice = next() % 4;
        let (entity_id, op_kind, payload) = if known_codes.is_empty() || choice == 0 {
            let id = format!("code-{seed:016x}-{ordinal:03}");
            known_codes.push(id.clone());
            (
                id,
                "code.create",
                serde_json::json!({
                    "name": format!("Synthetic-{seed:016x}-{ordinal:03}"),
                    "color": "#8a6410",
                    "sort_order": ordinal,
                }),
            )
        } else {
            let id = known_codes[(next() as usize) % known_codes.len()].clone();
            match choice {
                1 => (
                    id,
                    "code.patch",
                    serde_json::json!({
                        "patch": { "name": format!("Synthetic-{seed:016x}-edit-{ordinal:03}") }
                    }),
                ),
                2 => (id, "code.retire", serde_json::json!({})),
                _ => (id, "code.purge", serde_json::json!({})),
            }
        };
        writeln!(&mut trace, "{seq}:{actor}:{op_kind}:{entity_id}").unwrap();
        changes.push(model_change(seed, seq, actor, entity_id, op_kind, payload));
    }

    let head = changes.len() as i64;
    let mut clients = (0..client_count).map(|_| connection()).collect::<Vec<_>>();
    for (client_index, conn) in clients.iter_mut().enumerate() {
        // A delayed/reordered page is rejected as a gap and leaves all durable
        // state at zero. This models a drop before the ordered retry arrives.
        let out_of_order_index = 1 + (next() as usize % (changes.len() - 1));
        let out_of_order = &changes[out_of_order_index..=out_of_order_index];
        if db::apply_v2_pull_page(
            conn,
            "project",
            "00000000-0000-4000-8000-000000000002",
            0,
            head,
            out_of_order,
            &[],
        )
        .is_ok()
        {
            return Err(format!("seed {seed} accepted a reordered page\n{trace}"));
        }
        let cursor_after_gap = db::sync_state_value(conn, "sync_server_seq")
            .map_err(|error| error.to_string())?
            .unwrap_or_default();
        if cursor_after_gap != "0" {
            return Err(format!("seed {seed} advanced after a gap\n{trace}"));
        }

        let mut cursor = 0usize;
        while cursor < changes.len() {
            let page_len = 1 + (next() % 4) as usize;
            let page_end = (cursor + page_len).min(changes.len());
            let page = &changes[cursor..page_end];
            let expected_start = cursor as i64;
            let applied = db::apply_v2_pull_page(
                conn,
                "project",
                "00000000-0000-4000-8000-000000000002",
                expected_start,
                head,
                page,
                &[],
            )
            .map_err(|error| {
                format!("seed {seed} client {client_index} page failure: {error}\n{trace}")
            })?;
            if applied != page_end as i64 {
                return Err(format!("seed {seed} returned a wrong cursor\n{trace}"));
            }

            // A duplicated response after its receipt commits cannot apply a
            // second time or move the cursor. The caller must recover by
            // pulling from the current sequence instead.
            if db::apply_v2_pull_page(
                conn,
                "project",
                "00000000-0000-4000-8000-000000000002",
                expected_start,
                head,
                page,
                &[],
            )
            .is_ok()
            {
                return Err(format!("seed {seed} accepted a duplicate page\n{trace}"));
            }
            cursor = page_end;
        }

        let receipt_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM sync_applied_changes", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())?;
        if receipt_count != head {
            return Err(format!(
                "seed {seed} received duplicate or missing receipt\n{trace}"
            ));
        }
    }

    let expected = projection(&clients[0]);
    for (index, conn) in clients.iter().enumerate().skip(1) {
        if projection(conn) != expected {
            return Err(format!(
                "seed {seed} client {index} did not converge\n{trace}"
            ));
        }
    }
    Ok(())
}

#[test]
fn v2_gap_never_advances_the_cursor() {
    let conn = connection();
    let error = db::apply_v2_pull_page(
        &conn,
        "project",
        "00000000-0000-4000-8000-000000000002",
        0,
        2,
        &[code_change(2, "code-2")],
        &[],
    )
    .unwrap_err();
    assert!(error.to_string().contains("gap"));
    assert_eq!(
        db::sync_state_value(&conn, "sync_server_seq")
            .unwrap()
            .as_deref(),
        Some("0")
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM codebook", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn v2_page_is_atomic_across_reducer_failure_and_cursor() {
    let conn = connection();
    let mut invalid = code_change(2, "code-2");
    invalid.op_kind = "unsupported".into();
    assert!(db::apply_v2_pull_page(
        &conn,
        "project",
        "00000000-0000-4000-8000-000000000002",
        0,
        2,
        &[code_change(1, "code-1"), invalid],
        &[],
    )
    .is_err());
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM codebook", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM sync_applied_changes", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    assert_eq!(
        db::sync_state_value(&conn, "sync_server_seq")
            .unwrap()
            .as_deref(),
        Some("0")
    );
}

#[test]
fn v2_ordered_page_commits_projection_ledger_and_cursor_together() {
    let conn = connection();
    let next = db::apply_v2_pull_page(
        &conn,
        "project",
        "00000000-0000-4000-8000-000000000002",
        0,
        1,
        &[code_change(1, "code-1")],
        &[],
    )
    .unwrap();
    assert_eq!(next, 1);
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM codebook", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM sync_applied_changes", [], |row| row
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        1
    );
    assert_eq!(
        db::sync_state_value(&conn, "sync_server_seq")
            .unwrap()
            .as_deref(),
        Some("1")
    );
}

#[test]
fn v2_same_field_conflict_stays_durable_until_its_resolution_arrives() {
    let conn = connection();
    let generation = "00000000-0000-4000-8000-000000000002";
    let initial = code_change(1, "code-1");
    db::apply_v2_pull_page(&conn, "project", generation, 0, 1, &[initial], &[]).unwrap();

    let patch = V2IncomingChange {
        seq: 2,
        op_id: "00000000-0000-4000-8000-000000000022".into(),
        actor_key: "user:synthetic-actor-2".into(),
        entity_type: "code".into(),
        entity_id: "code-1".into(),
        op_kind: "code.patch".into(),
        payload: serde_json::json!({ "patch": { "name": "Synthetic proposed name" } }),
        created_at: "2026-08-23T00:00:02Z".into(),
    };
    let unresolved = V2IncomingConflict {
        conflict_id: "synthetic-conflict-1".into(),
        entity_type: "code".into(),
        entity_id: "code-1".into(),
        field_name: "name".into(),
        current_value: serde_json::json!({ "name": "Synthetic 1" }),
        proposed_value: serde_json::json!({ "name": "Synthetic proposed name" }),
        base_value: Some(serde_json::json!({ "name": "Synthetic 1" })),
        originating_op_id: patch.op_id.clone(),
        proposer_label: Some("Synthetic coder".into()),
        status: "unresolved".into(),
        created_at: "2026-08-23T00:00:02Z".into(),
        resolved_seq: None,
    };
    db::apply_v2_pull_page(
        &conn,
        "project",
        generation,
        1,
        2,
        &[patch],
        std::slice::from_ref(&unresolved),
    )
    .unwrap();
    assert_eq!(projection(&conn)[0].1, "Synthetic 1");
    assert_eq!(
        conn.query_row::<i64, _, _>(
            "SELECT COUNT(*) FROM sync_conflicts WHERE status = 'unresolved'",
            [],
            |row| row.get(0),
        )
        .unwrap(),
        1
    );

    let resolution = V2IncomingChange {
        seq: 3,
        op_id: "00000000-0000-4000-8000-000000000023".into(),
        actor_key: "user:synthetic-actor-1".into(),
        entity_type: "conflict".into(),
        entity_id: "synthetic-conflict-1".into(),
        op_kind: "conflict.resolve".into(),
        payload: serde_json::json!({
            "conflict_id": "synthetic-conflict-1",
            "resolution": "accept_proposal",
            "value": { "name": "Synthetic proposed name" },
        }),
        created_at: "2026-08-23T00:00:03Z".into(),
    };
    let mut resolved = unresolved;
    resolved.status = "resolved".into();
    resolved.resolved_seq = Some(3);
    db::apply_v2_pull_page(
        &conn,
        "project",
        generation,
        2,
        3,
        &[resolution],
        &[resolved],
    )
    .unwrap();
    assert_eq!(projection(&conn)[0].1, "Synthetic proposed name");
}

#[test]
fn v2_snapshot_rebuild_reapplies_a_durable_local_outbox() {
    let conn = connection();
    let local = db::create_code(
        &conn,
        &CreateCodeInput {
            name: "Synthetic local outbox code".into(),
            definition: None,
            inclusion_criteria: None,
            exclusion_criteria: None,
            example: None,
            parent_id: None,
            color: None,
        },
    )
    .unwrap();
    assert_eq!(db::list_v2_outbox(&conn, 0).unwrap().len(), 1);

    db::rebuild_v2_snapshot(
        &conn,
        "project",
        "00000000-0000-4000-8000-000000000002",
        7,
        &[serde_json::json!({
            "id": "remote-code",
            "name": "Synthetic remote code",
            "color": "#8a6410",
            "sort_order": 0,
            "is_retired": false,
            "deleted": false,
            "field_versions": { "name": 7 },
        })],
        &[],
        &[],
        &[],
    )
    .unwrap();

    let ids = projection(&conn)
        .into_iter()
        .map(|row| row.0)
        .collect::<Vec<_>>();
    assert!(ids.contains(&"remote-code".to_string()));
    assert!(ids.contains(&local.id));
    assert_eq!(db::list_v2_outbox(&conn, 0).unwrap().len(), 1);
    assert_eq!(
        db::sync_state_value(&conn, "sync_server_seq")
            .unwrap()
            .as_deref(),
        Some("7")
    );
}

#[test]
fn v2_model_fuzz_1000_seeds() {
    let start = std::time::Instant::now();
    let seed_count = std::env::var("CODEMAP_V2_FUZZ_SEEDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(1_000);
    for seed in 0..seed_count {
        if let Err(error) = run_v2_model_seed(seed) {
            panic!("v2 model fuzzer failed: {error}");
        }
    }
    let elapsed = start.elapsed();
    println!("v2 model fuzzer completed {seed_count} seeds in {elapsed:?}");
    assert!(
        elapsed.as_secs() < 180,
        "v2 model fuzzer exceeded the 180-second deterministic verification budget: {elapsed:?}"
    );
}
