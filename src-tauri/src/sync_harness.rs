//! Multi-client sync convergence test harness and fuzzer.
//!
//! Provides `VirtualClient` and `FakeServer` (in-memory PostgREST mock matching
//! `supabase/schema.sql` constraints) to test convergence across arbitrary
//! interleavings of edits and sync rounds without network dependencies.

#![cfg(test)]

use crate::db;
use crate::models::{
    ApplyCodesInput, CreateCodeInput, CreateInterviewInput, ImportSegmentsInput, SegmentInput,
};
use crate::sync::{self, CodePayload, CodedSegmentPayload, InterviewPayload, PullBatch};
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
use tempfile::TempDir;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct FakeProject {
    pub id: String,
    pub corpus_hash: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct FakeServer {
    pub clock_ms: u64,
    pub projects: HashMap<String, FakeProject>,
    pub codebook: HashMap<String, CodePayload>,
    pub interviews: HashMap<String, InterviewPayload>,
    pub coded_segments: HashMap<String, CodedSegmentPayload>,
}

impl FakeServer {
    pub fn new() -> Self {
        Self {
            clock_ms: 1_700_000_000_000,
            ..Default::default()
        }
    }

    pub fn now_iso(&mut self) -> String {
        self.clock_ms += 1000;
        let secs = self.clock_ms / 1000;
        let millis = self.clock_ms % 1000;
        format!(
            "2026-08-22T{:02}:{:02}:{:02}.{:03}Z",
            (secs / 3600) % 24,
            (secs / 60) % 60,
            secs % 60,
            millis
        )
    }

    pub fn set_corpus_hash(&mut self, project_id: &str, hash: &str) {
        self.projects.insert(
            project_id.to_string(),
            FakeProject {
                id: project_id.to_string(),
                corpus_hash: Some(hash.to_string()),
            },
        );
    }

    pub fn upsert_codebook(&mut self, project_id: &str, rows: &[CodePayload]) {
        for row in rows {
            let mut r = row.clone();
            r.project_id = project_id.to_string();
            r.updated_at = Some(self.now_iso());
            self.codebook.insert(r.id.clone(), r);
        }
    }

    pub fn upsert_interviews(&mut self, project_id: &str, rows: &[InterviewPayload]) {
        for row in rows {
            let mut r = row.clone();
            r.project_id = project_id.to_string();
            r.updated_at = Some(self.now_iso());
            self.interviews.insert(r.id.clone(), r);
        }
    }

    pub fn upsert_coded_segments(
        &mut self,
        project_id: &str,
        rows: &[CodedSegmentPayload],
    ) -> Result<(), String> {
        // Enforce unique (project_id, segment_id, coder_name, char_start, char_end) where deleted = false
        for row in rows {
            if !row.deleted {
                for existing in self.coded_segments.values() {
                    if existing.project_id == project_id
                        && existing.segment_id == row.segment_id
                        && existing.coder_name == row.coder_name
                        && existing.char_start == row.char_start
                        && existing.char_end == row.char_end
                        && !existing.deleted
                        && existing.id != row.id
                    {
                        return Err("409: DuplicateCoding".into());
                    }
                }
            }
        }

        for row in rows {
            let mut r = row.clone();
            r.project_id = project_id.to_string();
            r.updated_at = Some(self.now_iso());
            self.coded_segments.insert(r.id.clone(), r);
        }
        Ok(())
    }

    pub fn pull_codes(&self, project_id: &str, cursor: Option<&str>) -> Vec<CodePayload> {
        let cur = cursor.unwrap_or("1970-01-01T00:00:00Z");
        let mut list: Vec<_> = self
            .codebook
            .values()
            .filter(|r| r.project_id == project_id && r.updated_at.as_deref().unwrap_or("") >= cur)
            .cloned()
            .collect();
        list.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
        list
    }

    pub fn pull_interviews(&self, project_id: &str, cursor: Option<&str>) -> Vec<InterviewPayload> {
        let cur = cursor.unwrap_or("1970-01-01T00:00:00Z");
        let mut list: Vec<_> = self
            .interviews
            .values()
            .filter(|r| r.project_id == project_id && r.updated_at.as_deref().unwrap_or("") >= cur)
            .cloned()
            .collect();
        list.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
        list
    }

    pub fn pull_coded_segments(
        &self,
        project_id: &str,
        cursor: Option<&str>,
    ) -> Vec<CodedSegmentPayload> {
        let cur = cursor.unwrap_or("1970-01-01T00:00:00Z");
        let mut list: Vec<_> = self
            .coded_segments
            .values()
            .filter(|r| r.project_id == project_id && r.updated_at.as_deref().unwrap_or("") >= cur)
            .cloned()
            .collect();
        list.sort_by(|a, b| a.updated_at.cmp(&b.updated_at));
        list
    }

    pub fn fetch_coded_for_coders(
        &self,
        project_id: &str,
        coders: &[String],
    ) -> Vec<CodedSegmentPayload> {
        self.coded_segments
            .values()
            .filter(|r| r.project_id == project_id && coders.contains(&r.coder_name))
            .cloned()
            .collect()
    }
}

#[allow(dead_code)]
pub struct VirtualClient {
    pub id: String,
    pub coder_name: String,
    pub os: String,
    pub project_id: String,
    pub dir: TempDir,
    pub path: PathBuf,
    pub conn: Connection,
    pub coded_cursor: Option<String>,
    pub codebook_cursor: Option<String>,
    pub interview_cursor: Option<String>,
    pub is_online: bool,
}

impl VirtualClient {
    pub fn new(
        id: &str,
        coder_name: &str,
        os: &str,
        project_id: &str,
        seed_transcript: bool,
    ) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = db::create_project(&crate::models::CreateProjectInput {
            parent_dir: dir.path().to_string_lossy().to_string(),
            project_name: format!("proj-{}", id),
            title: format!("Study {}", id),
            coders: vec![coder_name.to_string()],
        })
        .unwrap();
        let conn = db::open_project(&path.to_string_lossy()).unwrap();
        sync::bind_to_group(&conn, project_id).unwrap();

        if seed_transcript {
            let iv = db::create_interview(
                &conn,
                &CreateInterviewInput {
                    participant_label: "P01".into(),
                    interview_date: None,
                    modality: None,
                    diagnosis_notes: None,
                    interviewers: vec![],
                },
            )
            .unwrap();

            db::import_segments(
                &conn,
                &ImportSegmentsInput {
                    interview_id: iv.id.clone(),
                    segments: vec![
                        SegmentInput {
                            speaker: "P01".into(),
                            timestamp_start: "00:00:00.000".into(),
                            timestamp_end: None,
                            text: "I rehearse social interactions beforehand.".into(),
                            section_tag: None,
                        },
                        SegmentInput {
                            speaker: "Interviewer".into(),
                            timestamp_start: "00:00:05.000".into(),
                            timestamp_end: None,
                            text: "How does that feel?".into(),
                            section_tag: None,
                        },
                        SegmentInput {
                            speaker: "P01".into(),
                            timestamp_start: "00:00:10.000".into(),
                            timestamp_end: None,
                            text: "Exhausting and draining.".into(),
                            section_tag: None,
                        },
                    ],
                    raw_vtt_path: None,
                },
            )
            .unwrap();
        }

        Self {
            id: id.to_string(),
            coder_name: coder_name.to_string(),
            os: os.to_string(),
            project_id: project_id.to_string(),
            dir,
            path,
            conn,
            coded_cursor: None,
            codebook_cursor: None,
            interview_cursor: None,
            is_online: true,
        }
    }

    pub fn create_code(&self, name: &str) -> String {
        let res = db::create_code(
            &self.conn,
            &CreateCodeInput {
                name: name.into(),
                definition: None,
                inclusion_criteria: None,
                exclusion_criteria: None,
                example: None,
                parent_id: None,
                color: None,
            },
        )
        .unwrap();
        res.id
    }

    pub fn apply_code(
        &self,
        interview_id: &str,
        segment_id: &str,
        code_ids: Vec<String>,
        span: Option<(i32, i32)>,
    ) {
        db::apply_codes(
            &self.conn,
            &ApplyCodesInput {
                interview_id: interview_id.into(),
                segment_id: segment_id.into(),
                code_ids,
                coder_name: self.coder_name.clone(),
                memo: None,
                char_start: span.map(|s| s.0),
                char_end: span.map(|s| s.1),
            },
        )
        .unwrap();
    }

    /// Simulate one full sync round: push dirty batch, mark pushed, pull, apply pull, update cursors.
    pub fn sync_with_server(&mut self, server: &mut FakeServer) -> Result<bool, String> {
        if !self.is_online {
            return Ok(false);
        }

        let pre_codes = db::list_codes(&self.conn).map_err(|e| e.to_string())?;
        let pre_coded =
            db::list_coded_segments(&self.conn, None, None).map_err(|e| e.to_string())?;

        let corpus_hash = sync::corpus_hash(&self.conn).map_err(|e| e.to_string())?;
        if let Some(existing_hash) = &server
            .projects
            .get(&self.project_id)
            .and_then(|p| p.corpus_hash.clone())
        {
            if corpus_hash != sync::EMPTY_CORPUS && corpus_hash != *existing_hash {
                // Reconcile corpus
                server.set_corpus_hash(&self.project_id, &corpus_hash);
            }
        } else if corpus_hash != sync::EMPTY_CORPUS {
            server.set_corpus_hash(&self.project_id, &corpus_hash);
        }

        // 1. Push phase
        let push_batch =
            sync::collect_push_batch(&self.conn, &self.project_id).map_err(|e| e.to_string())?;
        let mut pushed_count = 0;

        if !push_batch.is_empty() {
            server.upsert_codebook(&self.project_id, &push_batch.codes);
            server.upsert_interviews(&self.project_id, &push_batch.interviews);

            let push_res = server.upsert_coded_segments(&self.project_id, &push_batch.coded);
            match push_res {
                Ok(_) => {
                    sync::mark_pushed(&self.conn, &push_batch).map_err(|e| e.to_string())?;
                    pushed_count = push_batch.codes.len()
                        + push_batch.interviews.len()
                        + push_batch.coded.len();
                }
                Err(err) if err.contains("DuplicateCoding") => {
                    // Rescue path
                    let remote_matching = server.fetch_coded_for_coders(
                        &self.project_id,
                        std::slice::from_ref(&self.coder_name),
                    );
                    sync::apply_pull(
                        &self.conn,
                        &PullBatch {
                            coded: remote_matching,
                            codes: vec![],
                            interviews: vec![],
                            truncated: false,
                        },
                    )
                    .map_err(|e| e.to_string())?;
                    let retry_batch = sync::collect_push_batch(&self.conn, &self.project_id)
                        .map_err(|e| e.to_string())?;
                    server.upsert_coded_segments(&self.project_id, &retry_batch.coded)?;
                    sync::mark_pushed(&self.conn, &retry_batch).map_err(|e| e.to_string())?;
                    pushed_count = retry_batch.coded.len();
                }
                Err(e) => return Err(e),
            }
        }

        // 2. Pull phase
        let pulled_codes = server.pull_codes(&self.project_id, self.codebook_cursor.as_deref());
        let pulled_interviews =
            server.pull_interviews(&self.project_id, self.interview_cursor.as_deref());
        let pulled_coded =
            server.pull_coded_segments(&self.project_id, self.coded_cursor.as_deref());

        let pull_batch = PullBatch {
            coded: pulled_coded,
            codes: pulled_codes,
            interviews: pulled_interviews,
            truncated: false,
        };

        // 3. Apply phase
        let outcome = sync::apply_pull(&self.conn, &pull_batch).map_err(|e| e.to_string())?;

        if let Some(cursor) = sync::next_cursor(
            pull_batch.coded.iter().map(|r| &r.updated_at),
            &outcome.coded_receipt,
        ) {
            sync::set_state(&self.conn, sync::KEY_CODED_CURSOR, &cursor)
                .map_err(|e| e.to_string())?;
            self.coded_cursor = Some(cursor);
        }
        if let Some(cursor) = sync::next_cursor(
            pull_batch.codes.iter().map(|r| &r.updated_at),
            &outcome.codes_receipt,
        ) {
            sync::set_state(&self.conn, sync::KEY_CODEBOOK_CURSOR, &cursor)
                .map_err(|e| e.to_string())?;
            self.codebook_cursor = Some(cursor);
        }
        if let Some(cursor) = sync::next_cursor(
            pull_batch.interviews.iter().map(|r| &r.updated_at),
            &outcome.interviews_receipt,
        ) {
            sync::set_state(&self.conn, sync::KEY_INTERVIEW_CURSOR, &cursor)
                .map_err(|e| e.to_string())?;
            self.interview_cursor = Some(cursor);
        }

        let post_codes = db::list_codes(&self.conn).unwrap();
        let post_coded = db::list_coded_segments(&self.conn, None, None).unwrap();
        let changed = pushed_count > 0 || post_codes != pre_codes || post_coded != pre_coded;

        Ok(changed)
    }
}

pub fn sync_until_quiescence(
    clients: &mut [VirtualClient],
    server: &mut FakeServer,
    max_rounds: usize,
) -> usize {
    for round in 1..=max_rounds {
        let mut any_activity = false;
        for client in clients.iter_mut() {
            let changed = client.sync_with_server(server).expect("sync succeeds");
            if changed {
                any_activity = true;
            }
        }
        if !any_activity {
            return round;
        }
    }
    panic!(
        "Sync failed to converge to quiescence within {} rounds",
        max_rounds
    );
}

pub fn assert_converged(clients: &[VirtualClient], _server: &FakeServer) {
    assert!(
        !clients.is_empty(),
        "Cannot assert convergence on empty client set"
    );

    // Gather client 0's state
    let mut base_codes = db::list_codes(&clients[0].conn).unwrap();
    let mut base_coded = db::list_coded_segments(&clients[0].conn, None, None).unwrap();
    base_codes.sort_by(|a, b| a.id.cmp(&b.id));
    base_coded.sort_by(|a, b| {
        (&a.segment_id, &a.coder_name, a.char_start, a.char_end).cmp(&(
            &b.segment_id,
            &b.coder_name,
            b.char_start,
            b.char_end,
        ))
    });

    for client in &clients[1..] {
        let mut codes = db::list_codes(&client.conn).unwrap();
        let mut coded = db::list_coded_segments(&client.conn, None, None).unwrap();
        codes.sort_by(|a, b| a.id.cmp(&b.id));
        coded.sort_by(|a, b| {
            (&a.segment_id, &a.coder_name, a.char_start, a.char_end).cmp(&(
                &b.segment_id,
                &b.coder_name,
                b.char_start,
                b.char_end,
            ))
        });

        assert_eq!(
            codes.len(),
            base_codes.len(),
            "Client {} and Client {} code count differs: {} vs {}",
            clients[0].id,
            client.id,
            base_codes.len(),
            codes.len()
        );

        for (bc, c) in base_codes.iter().zip(codes.iter()) {
            assert_eq!(bc.id, c.id);
            assert_eq!(bc.name, c.name);
            assert_eq!(bc.is_retired, c.is_retired);
        }

        assert_eq!(
            coded.len(),
            base_coded.len(),
            "Client {} and Client {} coded count differs: {} vs {}",
            clients[0].id,
            client.id,
            base_coded.len(),
            coded.len()
        );

        for (bc, c) in base_coded.iter().zip(coded.iter()) {
            assert_eq!(bc.segment_id, c.segment_id);
            assert_eq!(bc.coder_name, c.coder_name);
            assert_eq!(bc.char_start, c.char_start);
            assert_eq!(bc.char_end, c.char_end);
            let mut b_codes = bc.code_ids.clone();
            let mut c_codes = c.code_ids.clone();
            b_codes.sort();
            c_codes.sort();
            assert_eq!(b_codes, c_codes);
        }
    }
}

// ── Scripted Scenarios (Tasks 6 & 7) ──────────────────────────────────────────

#[test]
fn two_coders_disjoint_passages() {
    let project_id = "test-disjoint";
    let mut server = FakeServer::new();
    let client_a = VirtualClient::new("A", "Alice", "macos", project_id, true);
    let client_b = VirtualClient::new("B", "Bob", "windows", project_id, true);

    let code_a = client_a.create_code("Anxiety");
    let code_b = client_b.create_code("Masking");

    let iv_id = crate::ids::interview_id("P01");
    let seg_0 = crate::ids::segment_id(&iv_id, 0, "I rehearse social interactions beforehand.");
    let seg_2 = crate::ids::segment_id(&iv_id, 2, "Exhausting and draining.");

    client_a.apply_code(&iv_id, &seg_0, vec![code_a], None);
    client_b.apply_code(&iv_id, &seg_2, vec![code_b], None);

    let mut clients = vec![client_a, client_b];
    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);
}

#[test]
fn two_coders_same_passage_different_codes() {
    let project_id = "test-same-passage";
    let mut server = FakeServer::new();
    let client_a = VirtualClient::new("A", "Alice", "macos", project_id, true);
    let client_b = VirtualClient::new("B", "Bob", "windows", project_id, true);

    let code_a = client_a.create_code("CodeA");
    let code_b = client_b.create_code("CodeB");

    let iv_id = crate::ids::interview_id("P01");
    let seg_0 = crate::ids::segment_id(&iv_id, 0, "I rehearse social interactions beforehand.");

    // Alice and Bob code the same passage with their respective codes
    client_a.apply_code(&iv_id, &seg_0, vec![code_a.clone()], None);
    client_b.apply_code(&iv_id, &seg_0, vec![code_b.clone()], None);

    let mut clients = vec![client_a, client_b];
    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);
}

#[test]
fn local_removal_survives_remote_edit() {
    let project_id = "test-removal-survives";
    let mut server = FakeServer::new();
    let client_a = VirtualClient::new("A", "Alice", "macos", project_id, true);
    let client_b = VirtualClient::new("B", "Bob", "windows", project_id, true);

    let code_1 = client_a.create_code("Code1");
    let code_2 = client_a.create_code("Code2");

    let iv_id = crate::ids::interview_id("P01");
    let seg_0 = crate::ids::segment_id(&iv_id, 0, "I rehearse social interactions beforehand.");

    // Alice codes [Code1, Code2] and syncs
    client_a.apply_code(&iv_id, &seg_0, vec![code_1.clone(), code_2.clone()], None);
    let mut clients = vec![client_a, client_b];
    sync_until_quiescence(&mut clients, &mut server, 10);

    // Alice removes Code1 locally (leaving [Code2])
    clients[0].apply_code(&iv_id, &seg_0, vec![code_2.clone()], None);
    // Bob makes an unrelated edit / creates Code3
    let code_3 = clients[1].create_code("Code3");
    clients[1].apply_code(&iv_id, &seg_0, vec![code_3], Some((0, 10)));

    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);

    // Verify Code1 did NOT resurrect for Alice
    let alice_coding = db::list_coded_segments(&clients[0].conn, Some(&iv_id), None).unwrap();
    let whole_turn = alice_coding
        .iter()
        .find(|c| c.char_start.is_none() && c.coder_name == "Alice")
        .unwrap();
    assert_eq!(whole_turn.code_ids, vec![code_2]);
}

#[test]
fn dirty_local_row_does_not_swallow_remote_change() {
    let project_id = "test-dirty-local-cursor";
    let mut server = FakeServer::new();
    let client_a = VirtualClient::new("A", "Alice", "macos", project_id, true);
    let client_b = VirtualClient::new("B", "Bob", "windows", project_id, true);

    let code_a = client_a.create_code("LocalCode");
    let mut clients = vec![client_a, client_b];
    sync_until_quiescence(&mut clients, &mut server, 10);

    // Bob renames code on remote
    db::update_code(
        &clients[1].conn,
        &crate::models::UpdateCodeInput {
            id: code_a.clone(),
            name: "RenamedByBob".into(),
            definition: None,
            inclusion_criteria: None,
            exclusion_criteria: None,
            example: None,
            parent_id: None,
            color: "#3B82F6".into(),
        },
    )
    .unwrap();
    clients[1].sync_with_server(&mut server).unwrap();

    // Alice edits same code locally (dirty)
    db::update_code(
        &clients[0].conn,
        &crate::models::UpdateCodeInput {
            id: code_a.clone(),
            name: "EditedByAlice".into(),
            definition: None,
            inclusion_criteria: None,
            exclusion_criteria: None,
            example: None,
            parent_id: None,
            color: "#3B82F6".into(),
        },
    )
    .unwrap();

    // Alice syncs: push lands first, then pull applies
    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);
}

#[test]
fn push_then_pull_does_not_clobber_local() {
    let project_id = "test-push-then-pull";
    let mut server = FakeServer::new();
    let mut client_a = VirtualClient::new("A", "Alice", "macos", project_id, true);
    let client_b = VirtualClient::new("B", "Bob", "windows", project_id, true);

    let code = client_a.create_code("TestCode");
    let iv_id = crate::ids::interview_id("P01");
    let seg_0 = crate::ids::segment_id(&iv_id, 0, "I rehearse social interactions beforehand.");

    client_a.apply_code(&iv_id, &seg_0, vec![code.clone()], None);

    // Alice syncs
    client_a.sync_with_server(&mut server).unwrap();

    // Check Alice's local coding is still intact
    let coding = db::list_coded_segments(&client_a.conn, Some(&iv_id), None).unwrap();
    assert_eq!(coding.len(), 1);
    assert_eq!(coding[0].code_ids, vec![code]);

    let mut clients = vec![client_a, client_b];
    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);
}

#[test]
fn offline_coder_reconnects_after_50_changes() {
    let project_id = "test-offline-reconnect";
    let mut server = FakeServer::new();
    let client_a = VirtualClient::new("A", "Alice", "macos", project_id, true);
    let client_b = VirtualClient::new("B", "Bob", "windows", project_id, true);

    let mut clients = vec![client_a, client_b];
    sync_until_quiescence(&mut clients, &mut server, 10);

    // Bob goes offline
    clients[1].is_online = false;

    // Alice creates 25 codes and 25 codings
    let iv_id = crate::ids::interview_id("P01");
    let seg_0 = crate::ids::segment_id(&iv_id, 0, "I rehearse social interactions beforehand.");

    for i in 0..25 {
        let code = clients[0].create_code(&format!("AliceCode{}", i));
        clients[0].apply_code(&iv_id, &seg_0, vec![code], Some((i, i + 1)));
    }
    clients[0].sync_with_server(&mut server).unwrap();

    // Bob comes back online and syncs
    clients[1].is_online = true;
    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);
}

#[test]
fn duplicate_span_409_rescue() {
    let project_id = "test-409-rescue";
    let mut server = FakeServer::new();
    let mut client_a = VirtualClient::new("A", "Ada", "macos", project_id, true);
    let client_b = VirtualClient::new("B", "Ada", "windows", project_id, true);

    let code_a = client_a.create_code("Apples");
    let code_b = client_b.create_code("Oranges");

    let iv_id = crate::ids::interview_id("P01");
    let seg_0 = crate::ids::segment_id(&iv_id, 0, "I rehearse social interactions beforehand.");

    // Alice on Mac codes span 0..10 under "Ada"
    client_a.apply_code(&iv_id, &seg_0, vec![code_a], Some((0, 10)));
    client_a.sync_with_server(&mut server).unwrap();

    // Bob on Windows codes exact same span 0..10 under "Ada"
    client_b.apply_code(&iv_id, &seg_0, vec![code_b], Some((0, 10)));

    let mut clients = vec![client_a, client_b];
    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);
}

#[test]
fn joiner_with_no_transcript_stages_then_drains() {
    let project_id = "test-joiner-stage";
    let mut server = FakeServer::new();
    let mut client_a = VirtualClient::new("A", "Alice", "macos", project_id, true);
    let mut client_b = VirtualClient::new("B", "Bob", "windows", project_id, false); // No transcript

    let code = client_a.create_code("Masking");
    let iv_id = crate::ids::interview_id("P01");
    let seg_0 = crate::ids::segment_id(&iv_id, 0, "I rehearse social interactions beforehand.");
    client_a.apply_code(&iv_id, &seg_0, vec![code], None);

    client_a.sync_with_server(&mut server).unwrap();

    // Bob pulls without transcript -> rows parked in pending_coded_segments
    client_b.sync_with_server(&mut server).unwrap();
    assert_eq!(db::pending_coded_count(&client_b.conn).unwrap(), 1);

    // Bob imports transcript -> auto drains
    db::import_segments(
        &client_b.conn,
        &ImportSegmentsInput {
            interview_id: iv_id,
            segments: vec![SegmentInput {
                speaker: "P01".into(),
                timestamp_start: "00:00:00.000".into(),
                timestamp_end: None,
                text: "I rehearse social interactions beforehand.".into(),
                section_tag: None,
            }],
            raw_vtt_path: None,
        },
    )
    .unwrap();

    assert_eq!(db::pending_coded_count(&client_b.conn).unwrap(), 0);
    let mut clients = vec![client_a, client_b];
    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);
}

#[test]
fn codebook_edit_races_coded_segment_push() {
    let project_id = "test-race";
    let mut server = FakeServer::new();
    let client_a = VirtualClient::new("A", "Alice", "macos", project_id, true);
    let client_b = VirtualClient::new("B", "Bob", "windows", project_id, true);

    let code = client_a.create_code("InitialCode");
    let mut clients = vec![client_a, client_b];
    sync_until_quiescence(&mut clients, &mut server, 10);

    // Alice creates new code and applies it
    let code_new = clients[0].create_code("NewCode");
    let iv_id = crate::ids::interview_id("P01");
    let seg_0 = crate::ids::segment_id(&iv_id, 0, "I rehearse social interactions beforehand.");
    clients[0].apply_code(&iv_id, &seg_0, vec![code, code_new], None);

    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);
}

#[test]
fn recovers_after_cursor_reset() {
    let project_id = "test-cursor-reset";
    let mut server = FakeServer::new();
    let client_a = VirtualClient::new("A", "Alice", "macos", project_id, true);
    let client_b = VirtualClient::new("B", "Bob", "windows", project_id, true);

    let code = client_a.create_code("ImportantCode");
    let iv_id = crate::ids::interview_id("P01");
    let seg_0 = crate::ids::segment_id(&iv_id, 0, "I rehearse social interactions beforehand.");
    client_a.apply_code(&iv_id, &seg_0, vec![code], None);

    let mut clients = vec![client_a, client_b];
    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);

    // Alice forgets cursor (simulating repair)
    sync::reset_cursors_for_repair(&clients[0].conn).unwrap();
    clients[0].coded_cursor = None;
    clients[0].codebook_cursor = None;
    clients[0].interview_cursor = None;

    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);
}

#[test]
fn three_clients_two_platforms() {
    let project_id = "test-three-clients";
    let mut server = FakeServer::new();
    let client_a = VirtualClient::new("A", "Alice", "macos", project_id, true);
    let client_b = VirtualClient::new("B", "Bob", "windows", project_id, true);
    let client_c = VirtualClient::new("C", "Charlie", "macos", project_id, true);

    let code_a = client_a.create_code("CodeFromA");
    let code_b = client_b.create_code("CodeFromB");
    let code_c = client_c.create_code("CodeFromC");

    let iv_id = crate::ids::interview_id("P01");
    let seg_0 = crate::ids::segment_id(&iv_id, 0, "I rehearse social interactions beforehand.");
    let seg_2 = crate::ids::segment_id(&iv_id, 2, "Exhausting and draining.");

    client_a.apply_code(&iv_id, &seg_0, vec![code_a], Some((0, 10)));
    client_b.apply_code(&iv_id, &seg_0, vec![code_b], Some((11, 20)));
    client_c.apply_code(&iv_id, &seg_2, vec![code_c], None);

    let mut clients = vec![client_a, client_b, client_c];
    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);
}

#[test]
fn test_divergence_and_rejoin_convergence() {
    let project_id = "test-divergence-rejoin-proj";
    let mut server = FakeServer::new();

    let client_a = VirtualClient::new("A", "Alice", "macos", project_id, true);
    let client_b = VirtualClient::new("B", "Bob", "windows", project_id, true);

    // Seed 10 segments in interview P02 for both clients
    for client in [&client_a, &client_b] {
        let iv = db::create_interview(
            &client.conn,
            &CreateInterviewInput {
                participant_label: "P02".into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();

        let segments: Vec<SegmentInput> = (0..10)
            .map(|i| SegmentInput {
                speaker: "P02".into(),
                timestamp_start: format!("00:0{:02}:00.000", i),
                timestamp_end: None,
                text: format!("Transcript passage number {} from participant P02.", i),
                section_tag: None,
            })
            .collect();

        db::import_segments(
            &client.conn,
            &ImportSegmentsInput {
                interview_id: iv.id,
                segments,
                raw_vtt_path: None,
            },
        )
        .unwrap();
    }

    let iv2_id = crate::ids::interview_id("P02");
    let seg_ids: Vec<String> = (0..10)
        .map(|i| {
            crate::ids::segment_id(
                &iv2_id,
                i as i64,
                &format!("Transcript passage number {} from participant P02.", i),
            )
        })
        .collect();

    // 1. Initial baseline code and sync to plateau
    let code_base = client_a.create_code("Baseline Code");
    let mut clients = vec![client_a, client_b];
    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);

    // 2. Alice unbinds locally
    sync::unbind_from_group(&clients[0].conn).unwrap();
    clients[0].coded_cursor = None;
    clients[0].codebook_cursor = None;
    clients[0].interview_cursor = None;

    // 3. While unbound:
    // Alice creates 3 new codes and codes 5 segments locally (segments 0..5)
    let code_a1 = clients[0].create_code("Alice Code 1");
    let code_a2 = clients[0].create_code("Alice Code 2");
    let code_a3 = clients[0].create_code("Alice Code 3");

    clients[0].apply_code(&iv2_id, &seg_ids[0], vec![code_a1.clone()], None);
    clients[0].apply_code(&iv2_id, &seg_ids[1], vec![code_a2.clone()], None);
    clients[0].apply_code(&iv2_id, &seg_ids[2], vec![code_a3.clone()], None);
    clients[0].apply_code(
        &iv2_id,
        &seg_ids[3],
        vec![code_a1.clone(), code_a2.clone()],
        None,
    );
    clients[0].apply_code(&iv2_id, &seg_ids[4], vec![code_a3.clone()], None);

    // Bob independently codes 4 segments on the server (segments 5..9)
    clients[1].apply_code(&iv2_id, &seg_ids[5], vec![code_base.clone()], None);
    clients[1].apply_code(&iv2_id, &seg_ids[6], vec![code_base.clone()], None);
    clients[1].apply_code(&iv2_id, &seg_ids[7], vec![code_base.clone()], None);
    clients[1].apply_code(&iv2_id, &seg_ids[8], vec![code_base.clone()], None);

    // Bob syncs to server while Alice is detached
    clients[1].sync_with_server(&mut server).unwrap();

    // 4. Alice re-binds to the group
    sync::bind_to_group(&clients[0].conn, project_id).unwrap();
    clients[0].coded_cursor = None;
    clients[0].codebook_cursor = None;
    clients[0].interview_cursor = None;

    // 5. Sync loop runs to next plateau
    sync_until_quiescence(&mut clients, &mut server, 15);
    assert_converged(&clients, &server);

    // 6. Assertions
    let a_codes = db::list_codes(&clients[0].conn).unwrap();
    let b_codes = db::list_codes(&clients[1].conn).unwrap();
    assert_eq!(a_codes.len(), 4); // Baseline + 3 Alice codes
    assert_eq!(b_codes.len(), 4);

    let a_coded = db::list_coded_segments(&clients[0].conn, None, None).unwrap();
    let b_coded = db::list_coded_segments(&clients[1].conn, None, None).unwrap();
    assert_eq!(a_coded.len(), 9); // 5 Alice segments + 4 Bob segments
    assert_eq!(b_coded.len(), 9);

    // Verify neither database has tombstoned/deleted rows
    let a_deleted: i64 = clients[0]
        .conn
        .query_row(
            "SELECT COUNT(*) FROM coded_segments WHERE deleted = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(a_deleted, 0);

    let b_deleted: i64 = clients[1]
        .conn
        .query_row(
            "SELECT COUNT(*) FROM coded_segments WHERE deleted = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(b_deleted, 0);

    // Verify cursors are non-zero (populated)
    assert!(clients[0].coded_cursor.is_some());
    assert!(clients[0].codebook_cursor.is_some());
    assert!(clients[1].coded_cursor.is_some());
    assert!(clients[1].codebook_cursor.is_some());
}

// ── Randomized Fuzzer (Task 7) ───────────────────────────────────────────────

#[test]
fn test_sync_fuzz_200_seeds() {
    let start = std::time::Instant::now();
    let num_seeds = std::env::var("FLEURON_FUZZ_SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);

    for seed in 0..num_seeds {
        fuzz_convergence(seed, 25);
    }
    let elapsed = start.elapsed();
    println!("Sync fuzzer completed {} seeds in {:?}", num_seeds, elapsed);
    // Guard against a pathological convergence blowup (an infinite sync loop or a
    // regression that makes convergence take orders of magnitude longer), not
    // against normal runtime. Shared CI runners vary wildly in speed — the same
    // 200 seeds have been measured from ~20s to ~56s on healthy macos-latest
    // builds — so a tight wall-clock budget produced flaky release failures.
    // Keep a generous ceiling that still trips on a true regression, tunable via
    // env for slower/faster machines. Mirrors the FLEURON_FUZZ_SEEDS idiom above.
    let budget_secs = std::env::var("FLEURON_FUZZ_BUDGET_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(180);
    assert!(
        elapsed.as_secs() < budget_secs,
        "Fuzzer exceeded {}-second budget: {:?} (set FLEURON_FUZZ_BUDGET_SECS to adjust)",
        budget_secs,
        elapsed
    );
}

pub fn fuzz_convergence(seed: u64, num_ops: usize) {
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    let mut rng = move || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        state
    };

    let project_id = format!("fuzz-proj-{}", seed);
    let mut server = FakeServer::new();
    let mut clients = vec![
        VirtualClient::new("A", "Alice", "macos", &project_id, true),
        VirtualClient::new("B", "Bob", "windows", &project_id, true),
        VirtualClient::new("C", "Charlie", "macos", &project_id, true),
    ];

    let iv_id = crate::ids::interview_id("P01");
    let seg_0 = crate::ids::segment_id(&iv_id, 0, "I rehearse social interactions beforehand.");
    let mut created_codes: Vec<String> = vec![];

    for _ in 0..num_ops {
        let client_idx = (rng() % 3) as usize;
        let op_type = rng() % 5;

        match op_type {
            0 => {
                // Create code
                let code_id =
                    clients[client_idx].create_code(&format!("Code_{}_{}", seed, rng() % 1000));
                created_codes.push(code_id);
            }
            1 => {
                // Apply code
                if !created_codes.is_empty() {
                    let code_id = created_codes[(rng() as usize) % created_codes.len()].clone();
                    let start = (rng() % 5) as i32;
                    let end = start + (rng() % 15) as i32 + 1;
                    clients[client_idx].apply_code(
                        &iv_id,
                        &seg_0,
                        vec![code_id],
                        Some((start, end)),
                    );
                }
            }
            2 => {
                // Toggle offline/online
                clients[client_idx].is_online = !clients[client_idx].is_online;
            }
            3 => {
                // Sync
                let _ = clients[client_idx].sync_with_server(&mut server);
            }
            4 if !created_codes.is_empty() => {
                // Delete code
                let idx = (rng() as usize) % created_codes.len();
                let code_id = &created_codes[idx];
                let _ = db::delete_code(
                    &clients[client_idx].conn,
                    code_id,
                    crate::models::DeleteCodeMode::Purge,
                );
            }
            _ => {}
        }
    }

    // Bring all online and sync to quiescence
    for client in clients.iter_mut() {
        client.is_online = true;
    }
    sync_until_quiescence(&mut clients, &mut server, 10);
    assert_converged(&clients, &server);
}
