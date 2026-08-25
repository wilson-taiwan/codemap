//! Real-SQLite test suite for the group control plane.
//!
//! Exercises bind, unbind, leave, delete, and reconcile transitions against
//! a real database initialized through the production schema and migrations.

#![cfg(test)]

use crate::db;
use crate::sync::{
    apply_delete_result, apply_leave_result, apply_reconcile_result, bind_to_group, get_state,
    is_bound, set_state, unbind_from_group, LocalDeleteOutcome, LocalLeaveOutcome,
    LocalReconcileOutcome, MembershipSummary, SyncError, KEY_CODEBOOK_CURSOR, KEY_CODED_CURSOR,
    KEY_GROUP_TITLE, KEY_INTERVIEW_CURSOR, KEY_PENDING_UNBIND, KEY_PROJECT_ID, KEY_ROLE,
};
use rusqlite::Connection;

fn test_conn() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    db::init_schema(&conn).unwrap();
    conn
}

fn seed_test_data(conn: &Connection) {
    let iv = db::create_interview(
        conn,
        &crate::models::CreateInterviewInput {
            participant_label: "P01".into(),
            interview_date: None,
            modality: None,
            diagnosis_notes: None,
            interviewers: vec![],
        },
    )
    .unwrap();

    db::import_segments(
        conn,
        &crate::models::ImportSegmentsInput {
            interview_id: iv.id.clone(),
            segments: vec![crate::models::SegmentInput {
                speaker: "Speaker 1".into(),
                timestamp_start: "00:00:00.000".into(),
                timestamp_end: None,
                text: "test transcript segment text".into(),
                section_tag: None,
            }],
            raw_vtt_path: None,
        },
    )
    .unwrap();

    let seg = db::get_segments(conn, &iv.id).unwrap()[0].id.clone();
    let code = db::create_code(
        conn,
        &crate::models::CreateCodeInput {
            name: "Theme 1".into(),
            definition: None,
            inclusion_criteria: None,
            exclusion_criteria: None,
            example: None,
            parent_id: None,
            color: None,
        },
    )
    .unwrap();

    db::apply_codes(
        conn,
        &crate::models::ApplyCodesInput {
            interview_id: iv.id,
            segment_id: seg,
            code_ids: vec![code.id],
            coder_name: "Ada".into(),
            memo: Some("test memo".into()),
            char_start: None,
            char_end: None,
        },
    )
    .unwrap();
}

#[test]
fn bind_to_group_sets_bound_and_resets_cursors() {
    let conn = test_conn();
    seed_test_data(&conn);

    assert!(!is_bound(&conn).unwrap());

    bind_to_group(&conn, "group-proj-uuid-1").unwrap();

    assert!(is_bound(&conn).unwrap());
    assert_eq!(
        get_state(&conn, KEY_PROJECT_ID).unwrap(),
        Some("group-proj-uuid-1".to_string())
    );
    assert_eq!(
        get_state(&conn, KEY_CODED_CURSOR).unwrap(),
        Some("1970-01-01T00:00:00Z".to_string())
    );
    assert_eq!(
        get_state(&conn, KEY_CODEBOOK_CURSOR).unwrap(),
        Some("1970-01-01T00:00:00Z".to_string())
    );
    assert_eq!(
        get_state(&conn, KEY_INTERVIEW_CURSOR).unwrap(),
        Some("1970-01-01T00:00:00Z".to_string())
    );

    // Binding to the same group again is idempotent
    assert!(bind_to_group(&conn, "group-proj-uuid-1").is_ok());

    // Binding to a DIFFERENT group while bound is refused
    let err = bind_to_group(&conn, "different-group-uuid").unwrap_err();
    assert_eq!(err, SyncError::AlreadyBound);
}

#[test]
fn unbind_from_group_clears_keys_and_redirties_all_tables() {
    let conn = test_conn();
    seed_test_data(&conn);
    bind_to_group(&conn, "group-proj-uuid-1").unwrap();

    // Mark clean
    conn.execute("UPDATE coded_segments SET sync_dirty = 0", [])
        .unwrap();
    conn.execute("UPDATE codebook SET sync_dirty = 0", [])
        .unwrap();
    conn.execute("UPDATE interviews SET sync_dirty = 0", [])
        .unwrap();
    set_state(&conn, KEY_ROLE, "admin").unwrap();
    set_state(&conn, KEY_GROUP_TITLE, "My Study").unwrap();
    set_state(&conn, KEY_PENDING_UNBIND, "1").unwrap();

    // Unbind
    unbind_from_group(&conn).unwrap();

    assert!(!is_bound(&conn).unwrap());
    let new_id = get_state(&conn, KEY_PROJECT_ID).unwrap().unwrap();
    assert_ne!(new_id, "group-proj-uuid-1");
    assert_eq!(get_state(&conn, KEY_ROLE).unwrap(), None);
    assert_eq!(get_state(&conn, KEY_GROUP_TITLE).unwrap(), None);
    assert_eq!(get_state(&conn, KEY_CODED_CURSOR).unwrap(), None);
    assert_eq!(get_state(&conn, KEY_CODEBOOK_CURSOR).unwrap(), None);
    assert_eq!(get_state(&conn, KEY_INTERVIEW_CURSOR).unwrap(), None);
    assert_eq!(get_state(&conn, KEY_PENDING_UNBIND).unwrap(), None);

    let dirty_coded: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM coded_segments WHERE sync_dirty = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let dirty_codes: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM codebook WHERE sync_dirty = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let dirty_ivs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM interviews WHERE sync_dirty = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(dirty_coded > 0 && dirty_codes > 0 && dirty_ivs > 0);

    // Calling a second time is idempotent
    assert!(unbind_from_group(&conn).is_ok());
}

#[test]
fn apply_leave_result_server_ok_clears_journal_and_unbinds() {
    let conn = test_conn();
    seed_test_data(&conn);
    bind_to_group(&conn, "group-leave-1").unwrap();
    set_state(
        &conn,
        KEY_PENDING_UNBIND,
        "{\"project_id\":\"group-leave-1\"}",
    )
    .unwrap();

    let outcome = apply_leave_result(&conn, Ok(()), "group-leave-1").unwrap();
    assert_eq!(outcome, LocalLeaveOutcome::UnboundCleanly);
    assert!(!is_bound(&conn).unwrap());
    assert_eq!(get_state(&conn, KEY_PENDING_UNBIND).unwrap(), None);
}

#[test]
fn apply_leave_result_server_not_found_404_treats_as_clean_leave() {
    let conn = test_conn();
    seed_test_data(&conn);
    bind_to_group(&conn, "group-leave-2").unwrap();
    set_state(
        &conn,
        KEY_PENDING_UNBIND,
        "{\"project_id\":\"group-leave-2\"}",
    )
    .unwrap();

    let server_err = SyncError::ServerRejected {
        status: 404,
        code: None,
        public_message: Some("Not found".into()),
    };
    let outcome = apply_leave_result(&conn, Err(&server_err), "group-leave-2").unwrap();
    assert_eq!(outcome, LocalLeaveOutcome::UnboundCleanly);
    assert!(!is_bound(&conn).unwrap());
    assert_eq!(get_state(&conn, KEY_PENDING_UNBIND).unwrap(), None);
}

#[test]
fn apply_leave_result_permission_denied_or_sole_admin_unbinds_locally_and_reports_error() {
    let conn = test_conn();
    seed_test_data(&conn);
    bind_to_group(&conn, "group-leave-3").unwrap();
    set_state(
        &conn,
        KEY_PENDING_UNBIND,
        "{\"project_id\":\"group-leave-3\"}",
    )
    .unwrap();

    let server_err = SyncError::ServerRejected {
        status: 400,
        code: Some("SOLE_ADMIN".into()),
        public_message: Some("A sole admin cannot leave the group; delete it instead.".into()),
    };
    let outcome = apply_leave_result(&conn, Err(&server_err), "group-leave-3").unwrap();
    match outcome {
        LocalLeaveOutcome::UnboundServerRejected(msg) => {
            assert!(msg.contains("sole admin") || msg.contains("400"));
        }
        other => panic!("Unexpected outcome: {:?}", other),
    }
    // Local unbind is respected, journal is cleared
    assert!(!is_bound(&conn).unwrap());
    assert_eq!(get_state(&conn, KEY_PENDING_UNBIND).unwrap(), None);
}

#[test]
fn apply_leave_result_network_error_unbinds_locally_and_retains_pending_journal() {
    let conn = test_conn();
    seed_test_data(&conn);
    bind_to_group(&conn, "group-leave-4").unwrap();

    let server_err = SyncError::Network("Connection refused".into());
    let outcome = apply_leave_result(&conn, Err(&server_err), "group-leave-4").unwrap();
    assert_eq!(outcome, LocalLeaveOutcome::UnboundWithPendingReconcile);
    assert!(!is_bound(&conn).unwrap());
    assert!(get_state(&conn, KEY_PENDING_UNBIND).unwrap().is_some());
}

#[test]
fn apply_delete_result_server_ok_clears_journal_and_unbinds() {
    let conn = test_conn();
    seed_test_data(&conn);
    bind_to_group(&conn, "group-del-1").unwrap();
    set_state(
        &conn,
        KEY_PENDING_UNBIND,
        "{\"project_id\":\"group-del-1\"}",
    )
    .unwrap();

    let outcome = apply_delete_result(&conn, Ok(())).unwrap();
    assert_eq!(outcome, LocalDeleteOutcome::UnboundCleanly);
    assert!(!is_bound(&conn).unwrap());
    assert_eq!(get_state(&conn, KEY_PENDING_UNBIND).unwrap(), None);
}

#[test]
fn apply_delete_result_server_not_found_404_treats_as_clean_delete() {
    let conn = test_conn();
    seed_test_data(&conn);
    bind_to_group(&conn, "group-del-2").unwrap();
    set_state(
        &conn,
        KEY_PENDING_UNBIND,
        "{\"project_id\":\"group-del-2\"}",
    )
    .unwrap();

    let server_err = SyncError::ServerRejected {
        status: 404,
        code: None,
        public_message: None,
    };
    let outcome = apply_delete_result(&conn, Err(&server_err)).unwrap();
    assert_eq!(outcome, LocalDeleteOutcome::UnboundCleanly);
    assert!(!is_bound(&conn).unwrap());
    assert_eq!(get_state(&conn, KEY_PENDING_UNBIND).unwrap(), None);
}

#[test]
fn apply_delete_result_permission_denied_clears_journal_and_retains_bound_state() {
    let conn = test_conn();
    seed_test_data(&conn);
    bind_to_group(&conn, "group-del-3").unwrap();
    set_state(
        &conn,
        KEY_PENDING_UNBIND,
        "{\"project_id\":\"group-del-3\"}",
    )
    .unwrap();

    let server_err = SyncError::PermissionDenied;
    let outcome = apply_delete_result(&conn, Err(&server_err)).unwrap();
    match outcome {
        LocalDeleteOutcome::DeleteRejected(_) => {}
        other => panic!("Unexpected outcome: {:?}", other),
    }
    // Delete was rejected by server, so local group remains bound
    assert!(is_bound(&conn).unwrap());
    assert_eq!(get_state(&conn, KEY_PENDING_UNBIND).unwrap(), None);
}

#[test]
fn apply_delete_result_network_error_retains_journal_and_bound_state() {
    let conn = test_conn();
    seed_test_data(&conn);
    bind_to_group(&conn, "group-del-4").unwrap();
    set_state(
        &conn,
        KEY_PENDING_UNBIND,
        "{\"project_id\":\"group-del-4\"}",
    )
    .unwrap();

    let server_err = SyncError::Network("DNS lookup failed".into());
    let outcome = apply_delete_result(&conn, Err(&server_err)).unwrap();
    match outcome {
        LocalDeleteOutcome::DeletePendingRetry(_) => {}
        other => panic!("Unexpected outcome: {:?}", other),
    }
    assert!(is_bound(&conn).unwrap());
    assert!(get_state(&conn, KEY_PENDING_UNBIND).unwrap().is_some());
}

#[test]
fn apply_reconcile_result_branches() {
    let conn = test_conn();
    seed_test_data(&conn);
    bind_to_group(&conn, "target-reconcile").unwrap();
    set_state(
        &conn,
        KEY_PENDING_UNBIND,
        "{\"project_id\":\"target-reconcile\"}",
    )
    .unwrap();

    // 1. Not in memberships list -> unbind and drain journal
    let memberships = vec![MembershipSummary {
        project_id: "other-project".into(),
        title: "Other".into(),
        coder_name: "Ada".into(),
        members: vec![],
        role: "coder".into(),
    }];
    let outcome = apply_reconcile_result(&conn, Ok(&memberships), "target-reconcile").unwrap();
    assert_eq!(outcome, LocalReconcileOutcome::UnboundAndDrained);
    assert!(!is_bound(&conn).unwrap());
    assert_eq!(get_state(&conn, KEY_PENDING_UNBIND).unwrap(), None);

    // 2. Still in memberships list -> clear journal, keep bound
    let conn2 = test_conn();
    seed_test_data(&conn2);
    bind_to_group(&conn2, "target-reconcile-2").unwrap();
    set_state(
        &conn2,
        KEY_PENDING_UNBIND,
        "{\"project_id\":\"target-reconcile-2\"}",
    )
    .unwrap();
    let memberships_with_target = vec![MembershipSummary {
        project_id: "target-reconcile-2".into(),
        title: "Target".into(),
        coder_name: "Ada".into(),
        members: vec![],
        role: "coder".into(),
    }];
    let outcome =
        apply_reconcile_result(&conn2, Ok(&memberships_with_target), "target-reconcile-2").unwrap();
    assert_eq!(outcome, LocalReconcileOutcome::AlreadyMemberClearedJournal);
    assert!(is_bound(&conn2).unwrap());
    assert_eq!(get_state(&conn2, KEY_PENDING_UNBIND).unwrap(), None);

    // 3. 404 from server -> unbind and drain
    let conn3 = test_conn();
    seed_test_data(&conn3);
    bind_to_group(&conn3, "target-reconcile-3").unwrap();
    set_state(
        &conn3,
        KEY_PENDING_UNBIND,
        "{\"project_id\":\"target-reconcile-3\"}",
    )
    .unwrap();
    let not_found_err = SyncError::ServerRejected {
        status: 404,
        code: None,
        public_message: None,
    };
    let outcome =
        apply_reconcile_result(&conn3, Err(&not_found_err), "target-reconcile-3").unwrap();
    assert_eq!(outcome, LocalReconcileOutcome::UnboundAndDrained);
    assert!(!is_bound(&conn3).unwrap());
    assert_eq!(get_state(&conn3, KEY_PENDING_UNBIND).unwrap(), None);

    // 4. Network error -> retain journal
    let conn4 = test_conn();
    seed_test_data(&conn4);
    bind_to_group(&conn4, "target-reconcile-4").unwrap();
    set_state(
        &conn4,
        KEY_PENDING_UNBIND,
        "{\"project_id\":\"target-reconcile-4\"}",
    )
    .unwrap();
    let net_err = SyncError::Network("Server down".into());
    let outcome = apply_reconcile_result(&conn4, Err(&net_err), "target-reconcile-4").unwrap();
    assert_eq!(outcome, LocalReconcileOutcome::RetainedPending);
    assert!(is_bound(&conn4).unwrap());
    assert!(get_state(&conn4, KEY_PENDING_UNBIND).unwrap().is_some());
}
