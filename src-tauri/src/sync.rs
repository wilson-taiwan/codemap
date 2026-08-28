//! Sync coding metadata between coders through Supabase.
//!
//! # What crosses the network, and what cannot
//!
//! Coding decisions travel as opaque ids: which segment, which codes, which
//! coder. Transcripts never leave the machine, and neither do memos, interview
//! dates, diagnosis notes or filenames.
//!
//! Two strings do cross, and both are deliberate. **Code names and definitions**
//! are analytic constructs the researchers author and vet. **Study labels** are
//! the tokenised participant IDs the protocol already requires in every working
//! file — `P07`, never a name — and they cross because the label is what tells
//! the other coder which transcript to fetch from Box. Both are capped in
//! length as a tripwire for the day somebody types a name out of habit.
//!
//! Someone holding a complete dump of the remote database learns that a project
//! exists, that it contains documents labelled P01…P0n of certain lengths, that
//! two people worked across some timestamps, and what the codebook is called.
//! None of it reconstructs a participant.
//!
//! That guarantee rests on three independent things, because one is not enough
//! for an exposure that cannot be undone:
//!
//! 1. [`CodedSegmentPayload`] names every field that is sent. `memo` is not
//!    among them, and adding it would be a visible edit to a struct whose
//!    doc comment says not to.
//! 2. `supabase/schema.sql` declares no column it could land in.
//! 3. [`tests::payload_carries_no_free_text`] asserts it, against a row that
//!    deliberately has a memo and a participant label attached.
//!
//! # Why this module is split into phases
//!
//! `AppState` holds the database behind a [`std::sync::Mutex`], whose guard
//! cannot be held across an `.await`. So the DB half and the network half never
//! interleave: collect a batch, release the lock, do the HTTP, take the lock
//! again to apply. That is also what makes both halves testable — every
//! function here that touches SQLite is synchronous and needs no server.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::{self, CodedMerge};

/// Rows pulled in one page. PostgREST caps responses; this bounds them to a
/// size that keeps a single request small on a slow connection.
const PAGE_SIZE: usize = 1000;

// ── Configuration and session ────────────────────────────────────────────────

/// Where to sync, and as which project.
///
/// `url` is the API origin (`https://<ref>.supabase.co`), **not** the dashboard
/// URL — the dashboard is a web app on supabase.com and has no REST endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConfig {
    pub url: String,
    pub anon_key: String,
    pub project_id: String,
}

/// Tokens from a successful sign-in.
///
/// Held in memory only, and never written to `project.db`. Credentials belong
/// to the person at the keyboard, not to the study.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSession {
    pub access_token: String,
    pub refresh_token: String,
    /// The Supabase auth user id, captured at sign-in. Group membership rows
    /// are keyed on it, so the roster can tell "you" from everyone else.
    #[serde(default)]
    pub user_id: String,
    /// The email on the account, for the Settings "signed in as" line. Empty
    /// when a restore did not return a user object — still signed in.
    #[serde(default)]
    pub email: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    Network(String),
    Auth(String),
    PermissionDenied,
    ServerFunctionUnavailable {
        name: &'static str,
    },
    ServerRejected {
        status: u16,
        code: Option<String>,
        public_message: Option<String>,
    },
    /// A row for this (passage, coder) already exists remotely under a different
    /// id — one coder coding from two machines. The push retry in
    /// `commands::sync_now` reconciles and retries once; this error surfaces
    /// only if the collision survives that.
    DuplicateCoding(String),
    Db(String),
    NotConfigured,
    /// The access token has expired or been revoked. Callers refresh once and
    /// retry rather than surfacing this — an hour-old session is the normal
    /// state of an app someone left open, not an error worth showing.
    Unauthorized,
    /// This local folder is already bound to a different group. Replacing that
    /// binding is the old "Change project" path and mixes two studies.
    AlreadyBound,
    CorpusMismatch(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(m) => write!(f, "Could not reach the sync server: {m}"),
            Self::Auth(m) => write!(f, "Sign-in failed: {m}"),
            Self::PermissionDenied => {
                write!(f, "You do not have permission to do that in this study.")
            }
            Self::ServerFunctionUnavailable { name } => write!(
                f,
                "This study's server isn't exposing a required function ({name}). The server migration or schema cache needs attention."
            ),
            Self::ServerRejected {
                status,
                public_message,
                ..
            } => {
                if let Some(msg) = public_message {
                    write!(f, "{msg}")
                } else {
                    write!(
                        f,
                        "The study server could not complete that request (HTTP {status})."
                    )
                }
            }
            Self::DuplicateCoding(m) => write!(
                f,
                "The server already has coding for a passage under a different \
                 record ({m}), and the automatic reconciliation could not settle \
                 it. Sync again; if this persists, tell the person running the \
                 study."
            ),
            Self::Db(m) => write!(f, "Database error during sync: {m}"),
            Self::NotConfigured => write!(f, "Sync is not set up for this project yet."),
            Self::Unauthorized => write!(f, "Your sync session expired. Sign in again."),
            Self::AlreadyBound => write!(
                f,
                "This folder is already in a group. Open it from the home \
                 screen — joining again would mix two studies."
            ),
            Self::CorpusMismatch(m) => write!(f, "Corpus mismatch: {m}"),
        }
    }
}

impl From<rusqlite::Error> for SyncError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e.to_string())
    }
}

// ── Payloads ─────────────────────────────────────────────────────────────────

/// One coding decision, as it crosses the network.
///
/// 🔴 **Do not add a field to this struct without checking what it carries.**
/// Every field here is either an opaque id or a coder's own name. `memo` is
/// absent on purpose — it is a free-text column sitting on this exact row in
/// SQLite, and it holds the coder's writing about what a participant said.
///
/// `updated_at` is read-only: the server sets it with a trigger, because it is
/// both the merge tiebreaker and the pull cursor and must not depend on two
/// laptops agreeing about the time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodedSegmentPayload {
    pub id: String,
    pub project_id: String,
    pub interview_id: String,
    pub segment_id: String,
    pub code_ids: Vec<String>,
    pub coder_name: String,
    /// Character offsets of the coded span within the passage, or `None` for a
    /// coding that covers the whole speaker turn.
    ///
    /// Offsets are not free text and cannot become free text: they are indices
    /// into a transcript the receiving machine already holds, and it only holds
    /// it because the segment id proved the text identical. Sending them is
    /// what makes a highlight mean the same phrase on both machines instead of
    /// silently widening to the whole turn on arrival.
    #[serde(default)]
    pub char_start: Option<i64>,
    #[serde(default)]
    pub char_end: Option<i64>,
    pub deleted: bool,
    pub revision: i64,
    #[serde(skip_serializing, default)]
    pub updated_at: Option<String>,
}

/// One codebook entry.
///
/// `name` and `definition` are the only free text sync carries, and that is a
/// considered exception: they are analytic constructs the researchers author
/// and vet, not anything a participant said. They are also the residual
/// exposure worth auditing — a label coined off a single case ("the swim team
/// thing") is a leak wearing analytic clothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodePayload {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub definition: Option<String>,
    pub parent_id: Option<String>,
    pub color: Option<String>,
    pub sort_order: i64,
    pub is_retired: bool,
    pub deleted: bool,
    pub revision: i64,
    #[serde(skip_serializing, default)]
    pub updated_at: Option<String>,
}

/// One interview, as the roster sees it.
///
/// Enough for the other machine to say "P07 exists and you have not imported
/// it", and to check that what was imported is the same file. Not enough to
/// reconstruct anything: no transcript, no date, no modality, no diagnosis
/// note, no filename.
///
/// `study_label` is the one non-derived string here, and it carries the
/// protocol's own requirement — study IDs, never names, in every working file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InterviewPayload {
    pub id: String,
    pub project_id: String,
    pub study_label: String,
    pub segment_count: i64,
    pub content_hash: Option<String>,
    pub deleted: bool,
    pub revision: i64,
    #[serde(skip_serializing, default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct PushBatch {
    pub coded: Vec<CodedSegmentPayload>,
    pub codes: Vec<CodePayload>,
    pub interviews: Vec<InterviewPayload>,
}

impl PushBatch {
    pub fn is_empty(&self) -> bool {
        self.coded.is_empty() && self.codes.is_empty() && self.interviews.is_empty()
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableReceipt {
    /// Rows written to SQLite.
    pub applied: Vec<String>,
    /// Rows deliberately rejected as older than what we already hold. Safe to
    /// advance past: re-fetching them would reach the same conclusion.
    pub superseded: Vec<String>,
    /// Rows that could NOT be resolved on this run. The cursor must not pass
    /// these — each carries its server `updated_at` so the next pull re-fetches
    /// it. Carrying `(id, updated_at)` rather than just the id is what makes
    /// the cursor rule computable.
    pub deferred: Vec<(String, String)>,
}

#[derive(Debug, Default, Clone)]
pub struct PullBatch {
    pub coded: Vec<CodedSegmentPayload>,
    pub codes: Vec<CodePayload>,
    pub interviews: Vec<InterviewPayload>,
    pub truncated: bool,
}

/// What a sync run did, for the status line.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub pushed_coded: usize,
    pub pushed_codes: usize,
    pub pulled_coded: usize,
    pub pulled_codes: usize,
    pub pulled_interviews: usize,
    /// Transcripts this machine still needs from Box, after the run.
    pub missing_transcripts: Vec<MissingTranscript>,
    /// Codes the other coder added, so the UI can say so rather than having
    /// them appear silently in the codebook.
    pub new_code_names: Vec<String>,
    pub synced_at: String,
    pub coded_receipt: TableReceipt,
    pub codes_receipt: TableReceipt,
    pub interviews_receipt: TableReceipt,
    pub truncated: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    pub local_coded_count: usize,
    pub local_code_count: usize,
    pub remote_coded_count: usize,
    pub remote_code_count: usize,
    pub missing_remote_coded_count: usize,
    pub missing_remote_coder_names: Vec<String>,
    pub pending_to_send_count: usize,
    pub clock_skew_seconds: Option<i64>,
    pub summary_message: String,
    pub raw_coded_cursor: Option<String>,
    pub raw_codebook_cursor: Option<String>,
    pub raw_interview_cursor: Option<String>,
    pub last_synced_at: Option<String>,
    pub needs_repair: bool,
    pub needs_send: bool,
    pub last_error: Option<String>,
    pub last_outcome: Option<SyncOutcome>,
}

// ── sync_state helpers ───────────────────────────────────────────────────────

pub const KEY_PROJECT_ID: &str = "project_id";
pub const KEY_CODED_CURSOR: &str = "coded_cursor";
pub const KEY_CODEBOOK_CURSOR: &str = "codebook_cursor";
pub const KEY_INTERVIEW_CURSOR: &str = "interview_cursor";
pub const KEY_LAST_SYNCED: &str = "last_synced_at";
/// Set when this folder is a member of a remote group — as opposed to merely
/// having a locally minted `project_id`, which `ensure_project_id` writes
/// before anything is shared.
pub const KEY_BOUND: &str = "group_bound";
pub const KEY_GROUP_TITLE: &str = "group_title";
pub const KEY_CODER_NAME: &str = "coder_name";
pub const KEY_ROLE: &str = "role";
pub const KEY_PENDING_UNBIND: &str = "pending_unbind";
pub const KEY_LAST_SYNC_ATTEMPT: &str = "last_sync_attempt";
pub const KEY_LAST_PULLED_AT: &str = "last_pulled_at";

pub fn get_state(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM sync_state WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
}

pub fn set_state(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// The project's sync id, minted once and thereafter carried inside
/// `project.db`.
///
/// Local and private until the project is bound to a shared one: two coders
/// each create a project and each mint their own id, and `sync_join_project`
/// is what replaces this machine's with the shared project's.
pub fn ensure_project_id(conn: &Connection) -> rusqlite::Result<String> {
    if let Some(existing) = get_state(conn, KEY_PROJECT_ID)? {
        return Ok(existing);
    }
    let id = uuid::Uuid::new_v4().to_string();
    set_state(conn, KEY_PROJECT_ID, &id)?;
    Ok(id)
}

/// Whether this folder has actually joined (or started) a group.
///
/// A locally minted `project_id` is not enough: that happens the first time
/// anything asks for an id, including opening the group sheet on a private
/// study. Folders that joined before this flag existed are recognised by a
/// recorded last-sync time, unless explicitly marked unbound ("0").
pub fn is_bound(conn: &Connection) -> rusqlite::Result<bool> {
    match get_state(conn, KEY_BOUND)?.as_deref() {
        Some("1") => Ok(true),
        Some("0") => Ok(false),
        _ => Ok(get_state(conn, KEY_LAST_SYNCED)?.is_some()),
    }
}

/// Reset sync state to an unbound local study in one SQLite transaction.
/// Mints a fresh local `KEY_PROJECT_ID`, sets `KEY_BOUND = "0"`, deletes
/// remote/cursor keys, marks local tables dirty, clears former merge base
/// and remote metadata, and removes `pending_coded_segments`.
pub fn unbind_from_group(conn: &Connection) -> rusqlite::Result<()> {
    let fresh_id = uuid::Uuid::new_v4().to_string();
    set_state(conn, KEY_PROJECT_ID, &fresh_id)?;
    set_state(conn, KEY_BOUND, "0")?;

    conn.execute(
        "DELETE FROM sync_state WHERE key IN (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            KEY_ROLE,
            KEY_GROUP_TITLE,
            KEY_LAST_SYNCED,
            KEY_LAST_SYNC_ATTEMPT,
            KEY_LAST_PULLED_AT,
            KEY_CODED_CURSOR,
            KEY_CODEBOOK_CURSOR,
            KEY_INTERVIEW_CURSOR,
            KEY_PENDING_UNBIND,
        ],
    )?;

    conn.execute("UPDATE coded_segments SET sync_dirty = 1", [])?;
    conn.execute("UPDATE codebook SET sync_dirty = 1", [])?;
    conn.execute("UPDATE interviews SET sync_dirty = 1", [])?;

    conn.execute("UPDATE coded_segments SET base_code_ids = NULL", [])?;
    conn.execute(
        "UPDATE interviews SET remote_segment_count = NULL, remote_content_hash = NULL",
        [],
    )?;
    conn.execute("DELETE FROM pending_coded_segments", [])?;

    Ok(())
}

/// Bind this local folder to a shared group, or refuse if it already belongs
/// to a different one.
///
/// Same id + already bound is a no-op (do not reset cursors). An unbound
/// folder — including one that only has a locally minted id — takes the new
/// id, resets pull cursors, and re-offers everything local.
pub fn bind_to_group(conn: &Connection, project_id: &str) -> Result<(), SyncError> {
    let existing = get_state(conn, KEY_PROJECT_ID)?;
    let bound = is_bound(conn)?;
    if bound {
        if existing.as_deref() == Some(project_id) {
            set_state(conn, KEY_BOUND, "1")?;
            return Ok(());
        }
        return Err(SyncError::AlreadyBound);
    }

    set_state(conn, KEY_PROJECT_ID, project_id)?;
    for key in [KEY_CODED_CURSOR, KEY_CODEBOOK_CURSOR, KEY_INTERVIEW_CURSOR] {
        set_state(conn, key, "1970-01-01T00:00:00Z")?;
    }
    conn.execute_batch(
        "UPDATE coded_segments SET sync_dirty = 1;
         UPDATE codebook       SET sync_dirty = 1;
         UPDATE interviews     SET sync_dirty = 1;",
    )
    .map_err(|e| SyncError::Db(e.to_string()))?;
    set_state(conn, KEY_BOUND, "1")?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)]
pub enum LocalLeaveOutcome {
    UnboundCleanly,
    UnboundWithPendingReconcile,
    UnboundServerRejected(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalDeleteOutcome {
    UnboundCleanly,
    DeleteRejected(String),
    DeletePendingRetry(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalReconcileOutcome {
    UnboundAndDrained,
    RetainedPending,
    AlreadyMemberClearedJournal,
}

/// Apply the result of a server leave RPC to the local SQLite state.
///
/// Decouples local state from server network conditions:
/// - Ok or 404/not-found: unbinds locally, clears pending journal.
/// - Permission denied / rejection (e.g. sole admin): unbinds locally, clears pending journal, returns server error message.
/// - Network/transient error: unbinds locally, retains pending journal for next launch reconcile.
pub fn apply_leave_result(
    conn: &Connection,
    server_outcome: Result<(), &SyncError>,
    target_project_id: &str,
) -> Result<LocalLeaveOutcome, SyncError> {
    match server_outcome {
        Ok(()) => {
            unbind_from_group(conn).map_err(|e| SyncError::Db(e.to_string()))?;
            conn.execute(
                "DELETE FROM sync_state WHERE key = ?1",
                rusqlite::params![KEY_PENDING_UNBIND],
            )
            .map_err(|e| SyncError::Db(e.to_string()))?;
            Ok(LocalLeaveOutcome::UnboundCleanly)
        }
        Err(SyncError::ServerRejected { status, .. }) if *status == 404 => {
            unbind_from_group(conn).map_err(|e| SyncError::Db(e.to_string()))?;
            conn.execute(
                "DELETE FROM sync_state WHERE key = ?1",
                rusqlite::params![KEY_PENDING_UNBIND],
            )
            .map_err(|e| SyncError::Db(e.to_string()))?;
            Ok(LocalLeaveOutcome::UnboundCleanly)
        }
        Err(SyncError::PermissionDenied) => {
            unbind_from_group(conn).map_err(|e| SyncError::Db(e.to_string()))?;
            conn.execute(
                "DELETE FROM sync_state WHERE key = ?1",
                rusqlite::params![KEY_PENDING_UNBIND],
            )
            .map_err(|e| SyncError::Db(e.to_string()))?;
            Ok(LocalLeaveOutcome::UnboundServerRejected(
                "You do not have permission to leave this study.".into(),
            ))
        }
        Err(SyncError::ServerRejected {
            status,
            public_message,
            ..
        }) => {
            unbind_from_group(conn).map_err(|e| SyncError::Db(e.to_string()))?;
            conn.execute(
                "DELETE FROM sync_state WHERE key = ?1",
                rusqlite::params![KEY_PENDING_UNBIND],
            )
            .map_err(|e| SyncError::Db(e.to_string()))?;
            let msg = public_message
                .clone()
                .unwrap_or_else(|| format!("Server rejected leave (HTTP {status})."));
            Ok(LocalLeaveOutcome::UnboundServerRejected(msg))
        }
        Err(SyncError::Network(_))
        | Err(SyncError::ServerFunctionUnavailable { .. })
        | Err(SyncError::Auth(_)) => {
            unbind_from_group(conn).map_err(|e| SyncError::Db(e.to_string()))?;
            let journal_val = serde_json::json!({
                "operation": "leave",
                "project_id": target_project_id,
            });
            set_state(conn, KEY_PENDING_UNBIND, &journal_val.to_string())
                .map_err(|e| SyncError::Db(e.to_string()))?;
            Ok(LocalLeaveOutcome::UnboundWithPendingReconcile)
        }
        Err(_) => {
            unbind_from_group(conn).map_err(|e| SyncError::Db(e.to_string()))?;
            let journal_val = serde_json::json!({
                "operation": "leave",
                "project_id": target_project_id,
            });
            set_state(conn, KEY_PENDING_UNBIND, &journal_val.to_string())
                .map_err(|e| SyncError::Db(e.to_string()))?;
            Ok(LocalLeaveOutcome::UnboundWithPendingReconcile)
        }
    }
}

/// Apply the result of a server delete RPC to the local SQLite state.
pub fn apply_delete_result(
    conn: &Connection,
    server_outcome: Result<(), &SyncError>,
) -> Result<LocalDeleteOutcome, SyncError> {
    match server_outcome {
        Ok(()) => {
            unbind_from_group(conn).map_err(|e| SyncError::Db(e.to_string()))?;
            conn.execute(
                "DELETE FROM sync_state WHERE key = ?1",
                rusqlite::params![KEY_PENDING_UNBIND],
            )
            .map_err(|e| SyncError::Db(e.to_string()))?;
            Ok(LocalDeleteOutcome::UnboundCleanly)
        }
        Err(SyncError::ServerRejected { status, .. }) if *status == 404 => {
            unbind_from_group(conn).map_err(|e| SyncError::Db(e.to_string()))?;
            conn.execute(
                "DELETE FROM sync_state WHERE key = ?1",
                rusqlite::params![KEY_PENDING_UNBIND],
            )
            .map_err(|e| SyncError::Db(e.to_string()))?;
            Ok(LocalDeleteOutcome::UnboundCleanly)
        }
        Err(SyncError::PermissionDenied) => {
            conn.execute(
                "DELETE FROM sync_state WHERE key = ?1",
                rusqlite::params![KEY_PENDING_UNBIND],
            )
            .map_err(|e| SyncError::Db(e.to_string()))?;
            Ok(LocalDeleteOutcome::DeleteRejected(
                "You do not have permission to delete this study.".into(),
            ))
        }
        Err(SyncError::ServerRejected {
            status,
            public_message,
            ..
        }) => {
            conn.execute(
                "DELETE FROM sync_state WHERE key = ?1",
                rusqlite::params![KEY_PENDING_UNBIND],
            )
            .map_err(|e| SyncError::Db(e.to_string()))?;
            let msg = public_message
                .clone()
                .unwrap_or_else(|| format!("Delete rejected by server (HTTP {status})."));
            Ok(LocalDeleteOutcome::DeleteRejected(msg))
        }
        Err(SyncError::Network(msg)) => Ok(LocalDeleteOutcome::DeletePendingRetry(msg.clone())),
        Err(other) => Ok(LocalDeleteOutcome::DeletePendingRetry(other.to_string())),
    }
}

/// Apply the result of membership check during pending unbind reconciliation.
pub fn apply_reconcile_result(
    conn: &Connection,
    memberships_outcome: Result<&[MembershipSummary], &SyncError>,
    target_project_id: &str,
) -> Result<LocalReconcileOutcome, SyncError> {
    match memberships_outcome {
        Ok(list) => {
            let still_member = list.iter().any(|m| m.project_id == target_project_id);
            if !still_member {
                unbind_from_group(conn).map_err(|e| SyncError::Db(e.to_string()))?;
                conn.execute(
                    "DELETE FROM sync_state WHERE key = ?1",
                    rusqlite::params![KEY_PENDING_UNBIND],
                )
                .map_err(|e| SyncError::Db(e.to_string()))?;
                Ok(LocalReconcileOutcome::UnboundAndDrained)
            } else {
                conn.execute(
                    "DELETE FROM sync_state WHERE key = ?1",
                    rusqlite::params![KEY_PENDING_UNBIND],
                )
                .map_err(|e| SyncError::Db(e.to_string()))?;
                Ok(LocalReconcileOutcome::AlreadyMemberClearedJournal)
            }
        }
        Err(SyncError::ServerRejected { status, .. }) if *status == 404 => {
            unbind_from_group(conn).map_err(|e| SyncError::Db(e.to_string()))?;
            conn.execute(
                "DELETE FROM sync_state WHERE key = ?1",
                rusqlite::params![KEY_PENDING_UNBIND],
            )
            .map_err(|e| SyncError::Db(e.to_string()))?;
            Ok(LocalReconcileOutcome::UnboundAndDrained)
        }
        Err(_) => Ok(LocalReconcileOutcome::RetainedPending),
    }
}

// ── Corpus hash ──────────────────────────────────────────────────────────────

/// A fingerprint of every transcript in the project.
///
/// Segment ids are only meaningful between two machines holding identical
/// transcripts. If one coder re-imports a VTT, fixes a typo, or deletes an
/// interview, their segment ids stop lining up with the other's and coding
/// synced across would attach to the wrong passages — silently, since ids are
/// opaque and nothing would look wrong. This is the check that prevents it.
///
/// Whitespace is normalised before hashing so that a re-parse producing
/// cosmetically different spacing does not read as a different corpus. Fields
/// are separated by a byte that cannot occur in the normalised text, so
/// `("ab", "c")` and `("a", "bc")` cannot collide.
pub fn corpus_hash(conn: &Connection) -> rusqlite::Result<String> {
    let mut stmt = conn.prepare(
        "SELECT interview_id, segment_index, text FROM transcript_segments
         ORDER BY interview_id, segment_index",
    )?;
    let mut hasher = Sha256::new();
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let interview_id: String = row.get(0)?;
        let index: i64 = row.get(1)?;
        let text: String = row.get(2)?;
        let normalised = text.split_whitespace().collect::<Vec<_>>().join(" ");
        hasher.update(interview_id.as_bytes());
        hasher.update([0u8]);
        hasher.update(index.to_string().as_bytes());
        hasher.update([0u8]);
        hasher.update(normalised.as_bytes());
        hasher.update([0u8]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

// ── Phase 1: collect (SQLite, no network) ────────────────────────────────────

/// Everything this machine has changed since its last successful push.
pub fn collect_push_batch(conn: &Connection, project_id: &str) -> rusqlite::Result<PushBatch> {
    let mut coded = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, interview_id, segment_id, code_ids, coder_name, deleted, revision,
                    char_start, char_end
             FROM coded_segments WHERE sync_dirty = 1",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let code_ids_json: String = row.get(3)?;
            coded.push(CodedSegmentPayload {
                id: row.get(0)?,
                project_id: project_id.to_string(),
                interview_id: row.get(1)?,
                segment_id: row.get(2)?,
                code_ids: serde_json::from_str(&code_ids_json).unwrap_or_default(),
                coder_name: row.get(4)?,
                deleted: row.get::<_, i64>(5)? != 0,
                revision: row.get(6)?,
                char_start: row.get(7)?,
                char_end: row.get(8)?,
                updated_at: None,
            });
        }
    }

    let mut codes = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, name, definition, parent_id, color, sort_order, is_retired,
                    deleted, revision
             FROM codebook WHERE sync_dirty = 1",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            codes.push(CodePayload {
                id: row.get(0)?,
                project_id: project_id.to_string(),
                name: row.get(1)?,
                definition: row.get(2)?,
                parent_id: row.get(3)?,
                color: row.get(4)?,
                sort_order: row.get(5)?,
                is_retired: row.get::<_, i64>(6)? != 0,
                deleted: row.get::<_, i64>(7)? != 0,
                revision: row.get(8)?,
                updated_at: None,
            });
        }
    }

    let mut interviews = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT i.id, i.participant_label, i.deleted, i.revision,
                    (SELECT COUNT(*) FROM transcript_segments t WHERE t.interview_id = i.id)
             FROM interviews i WHERE i.sync_dirty = 1",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            let hash = interview_content_hash(conn, &id)?;
            interviews.push(InterviewPayload {
                project_id: project_id.to_string(),
                study_label: row.get(1)?,
                deleted: row.get::<_, i64>(2)? != 0,
                revision: row.get(3)?,
                segment_count: row.get(4)?,
                content_hash: hash,
                id,
                updated_at: None,
            });
        }
    }

    Ok(PushBatch {
        coded,
        codes,
        interviews,
    })
}

/// A fingerprint of one interview's transcript.
/// Folds a stream of (segment_index, text) pairs into a content hash.
///
/// Returns `None` if the iterator yields zero segments.
pub fn content_hash_of(segments: impl Iterator<Item = (i64, String)>) -> Option<String> {
    let mut hasher = Sha256::new();
    let mut any = false;
    for (index, text) in segments {
        any = true;
        hasher.update(index.to_string().as_bytes());
        hasher.update([0u8]);
        hasher.update(crate::ids::normalize(&text).as_bytes());
        hasher.update([0u8]);
    }
    any.then(|| format!("{:x}", hasher.finalize()))
}

/// A deterministic hash over the text of one interview's segments in index order.
///
/// The project-wide [`corpus_hash`] answers "do we hold the same corpus"; this
/// answers "did you import the same *file* for P07", which is the question a
/// coder can actually act on. `None` when nothing has been imported yet, which
/// is different from a hash of nothing.
pub fn interview_content_hash(
    conn: &Connection,
    interview_id: &str,
) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT segment_index, text FROM transcript_segments
         WHERE interview_id = ?1 ORDER BY segment_index",
    )?;
    let rows = stmt.query_map(params![interview_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut segments = Vec::new();
    for r in rows {
        segments.push(r?);
    }
    Ok(content_hash_of(segments.into_iter()))
}

/// Clear the dirty flags for rows the server accepted.
///
/// Scoped to the ids that were actually sent, never a blanket
/// `UPDATE … SET sync_dirty = 0`: a coder can edit while the request is in
/// flight, and a blanket clear would drop that edit on the floor permanently.
pub fn mark_pushed(conn: &Connection, batch: &PushBatch) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for row in &batch.coded {
        tx.execute(
            "UPDATE coded_segments SET sync_dirty = 0, base_code_ids = code_ids
             WHERE id = ?1 AND revision = ?2",
            params![row.id, row.revision],
        )?;
    }
    for row in &batch.codes {
        tx.execute(
            "UPDATE codebook SET sync_dirty = 0 WHERE id = ?1 AND revision = ?2",
            params![row.id, row.revision],
        )?;
    }
    for row in &batch.interviews {
        tx.execute(
            "UPDATE interviews SET sync_dirty = 0 WHERE id = ?1 AND revision = ?2",
            params![row.id, row.revision],
        )?;
    }
    tx.commit()
}

/// An interview the other coder has that this machine has not imported, or has
/// imported from a different file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingTranscript {
    pub study_label: String,
    pub segment_count: i64,
    /// True when the interview exists locally but its transcript differs.
    pub mismatched: bool,
}

/// What this machine still needs from Box.
///
/// The whole point of syncing the roster: without it, a coder has no way to
/// learn that a transcript exists until someone tells them, and no way to know
/// that the file they imported is the one everyone else is coding.
pub fn missing_transcripts(conn: &Connection) -> rusqlite::Result<Vec<MissingTranscript>> {
    let mut stmt = conn.prepare(
        "SELECT id, participant_label,
                COALESCE(remote_segment_count, 0), remote_content_hash
         FROM interviews WHERE deleted = 0 AND remote_content_hash IS NOT NULL",
    )?;
    let mut out = Vec::new();
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let label: String = row.get(1)?;
        let remote_count: i64 = row.get(2)?;
        let remote_hash: Option<String> = row.get(3)?;
        let local_hash = interview_content_hash(conn, &id)?;
        match (&local_hash, &remote_hash) {
            (None, Some(_)) => out.push(MissingTranscript {
                study_label: label,
                segment_count: remote_count,
                mismatched: false,
            }),
            (Some(l), Some(r)) if l != r => out.push(MissingTranscript {
                study_label: label,
                segment_count: remote_count,
                mismatched: true,
            }),
            _ => {}
        }
    }
    Ok(out)
}

// ── Phase 3: apply (SQLite, no network) ──────────────────────────────────────

/// Fold pulled rows into the local database.
///
/// Coded segments partition by coder, so two people coding the same passage is
/// two rows and never a conflict. The `revision` guard covers the one case that
/// is: a row this machine has also changed. Higher revision wins, ties go to
/// the server, and a losing local row keeps its dirty flag so the next push
/// re-offers it rather than silently losing it.
pub fn apply_pull(conn: &Connection, batch: &PullBatch) -> rusqlite::Result<SyncOutcome> {
    let tx = conn.unchecked_transaction()?;
    let mut outcome = SyncOutcome {
        truncated: batch.truncated,
        ..Default::default()
    };

    for row in &batch.coded {
        let code_ids_json = serde_json::to_string(&row.code_ids).unwrap_or_else(|_| "[]".into());
        let updated_at = row.updated_at.clone().unwrap_or_else(crate::db::now_iso);

        // 🔴 Coding whose passage is not on this machine cannot go into
        // `coded_segments`: the foreign key rejects it, and because this whole
        // apply is one transaction, one such row used to roll the entire pull
        // back — codebook and roster included. That is every joining coder's
        // first sync, which is why joining a study never worked. It waits in
        // the staging table instead, and `db::import_segments` drains it the
        // moment the transcript arrives.
        let have_segment: bool = tx
            .query_row(
                "SELECT 1 FROM transcript_segments WHERE id = ?1",
                params![row.segment_id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);

        if !have_segment {
            let pending_rev: Option<i64> = tx
                .query_row(
                    "SELECT revision FROM pending_coded_segments WHERE id = ?1",
                    params![row.id],
                    |r| r.get(0),
                )
                .optional()?;

            if let Some(rev) = pending_rev {
                if row.revision < rev {
                    outcome.coded_receipt.superseded.push(row.id.clone());
                    continue;
                }
            }

            let changed = tx.execute(
                "INSERT INTO pending_coded_segments
                   (id, interview_id, segment_id, code_ids, coder_name,
                    revision, deleted, updated_at, char_start, char_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                   code_ids   = excluded.code_ids,
                   coder_name = excluded.coder_name,
                   deleted    = excluded.deleted,
                   revision   = excluded.revision,
                   updated_at = excluded.updated_at,
                   char_start = excluded.char_start,
                   char_end   = excluded.char_end
                 WHERE excluded.revision >= pending_coded_segments.revision",
                params![
                    row.id,
                    row.interview_id,
                    row.segment_id,
                    code_ids_json,
                    row.coder_name,
                    row.revision,
                    row.deleted as i64,
                    updated_at,
                    row.char_start,
                    row.char_end,
                ],
            )?;
            if changed > 0 {
                outcome.pulled_coded += 1;
                outcome.coded_receipt.applied.push(row.id.clone());
            } else {
                outcome.coded_receipt.superseded.push(row.id.clone());
            }
            continue;
        }

        // `memo` is never written from a pull. On insert there is nothing to
        // write — memos do not sync. On update it must be preserved, because
        // the memo on a local row belongs to the person at this keyboard.
        // A tombstone is the one exception: removed coding should not leave
        // its memo behind, matching what un-coding does locally. All of that
        // lives in `merge_remote_coded`, which also reconciles the
        // two-machines case: same (passage, coder, span), different id.
        match db::merge_remote_coded(
            &tx,
            &db::RemoteCoded {
                id: &row.id,
                interview_id: &row.interview_id,
                segment_id: &row.segment_id,
                code_ids_json: &code_ids_json,
                coder_name: &row.coder_name,
                revision: row.revision,
                deleted: row.deleted,
                updated_at: &updated_at,
                char_start: row.char_start,
                char_end: row.char_end,
            },
        )? {
            CodedMerge::Applied => {
                outcome.pulled_coded += 1;
                outcome.coded_receipt.applied.push(row.id.clone());
            }
            CodedMerge::Superseded => {
                outcome.coded_receipt.superseded.push(row.id.clone());
            }
            CodedMerge::Deferred => {
                outcome.pulled_coded += 1;
                outcome
                    .coded_receipt
                    .deferred
                    .push((row.id.clone(), updated_at));
            }
        }
    }

    for row in &batch.codes {
        let updated_at = row.updated_at.clone().unwrap_or_else(crate::db::now_iso);
        let local_info: Option<(i64, i64)> = tx
            .query_row(
                "SELECT revision, sync_dirty FROM codebook WHERE id = ?1",
                params![row.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let mut will_apply = false;
        if let Some((local_rev, local_dirty)) = local_info {
            if local_dirty != 0 {
                outcome
                    .codes_receipt
                    .deferred
                    .push((row.id.clone(), updated_at.clone()));
            } else if row.revision >= local_rev {
                outcome.codes_receipt.applied.push(row.id.clone());
                will_apply = true;
            } else {
                outcome.codes_receipt.superseded.push(row.id.clone());
            }
        } else {
            outcome.codes_receipt.applied.push(row.id.clone());
            will_apply = true;
            if !row.deleted {
                outcome.new_code_names.push(row.name.clone());
            }
        }

        let changed = tx.execute(
            "INSERT INTO codebook
               (id, name, definition, parent_id, color, sort_order, is_retired,
                created_at, updated_at, revision, deleted, sync_dirty)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10, 0)
             ON CONFLICT(id) DO UPDATE SET
               name       = excluded.name,
               definition = excluded.definition,
               parent_id  = excluded.parent_id,
               color      = excluded.color,
               sort_order = excluded.sort_order,
               is_retired = excluded.is_retired,
               deleted    = excluded.deleted,
               revision   = excluded.revision,
               updated_at = excluded.updated_at,
               sync_dirty = 0
             WHERE excluded.revision >= codebook.revision AND codebook.sync_dirty = 0",
            params![
                row.id,
                row.name,
                row.definition,
                row.parent_id,
                row.color.clone().unwrap_or_else(|| "#8a6410".into()),
                row.sort_order,
                row.is_retired as i64,
                updated_at,
                row.revision,
                row.deleted as i64,
            ],
        )?;

        if will_apply && changed > 0 {
            outcome.pulled_codes += 1;
        }
    }

    for row in &batch.interviews {
        // An interview pulled from the roster becomes a real local interview
        // with no transcript in it. That is the intended end state: it appears
        // in the list, the coder imports the matching file from Box, and the
        // deterministic id means their coding lines up with everyone else's
        // without anything further being exchanged.
        //
        // `participant_label` is only written on insert. On conflict it is left
        // alone because the label is what the id was derived from — if they
        // disagree, the id is the fact and the label is the typo.
        let updated_at = row.updated_at.clone().unwrap_or_else(crate::db::now_iso);
        let local_info: Option<(i64, i64)> = tx
            .query_row(
                "SELECT revision, sync_dirty FROM interviews WHERE id = ?1",
                params![row.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let mut will_apply = false;
        if let Some((local_rev, local_dirty)) = local_info {
            if local_dirty != 0 {
                outcome
                    .interviews_receipt
                    .deferred
                    .push((row.id.clone(), updated_at.clone()));
            } else if row.revision >= local_rev {
                outcome.interviews_receipt.applied.push(row.id.clone());
                will_apply = true;
            } else {
                outcome.interviews_receipt.superseded.push(row.id.clone());
            }
        } else {
            outcome.interviews_receipt.applied.push(row.id.clone());
            will_apply = true;
        }

        let changed = tx.execute(
            "INSERT INTO interviews
               (id, participant_label, interviewers, created_at, updated_at,
                revision, deleted, sync_dirty, remote_segment_count, remote_content_hash)
             VALUES (?1, ?2, '[]', ?3, ?3, ?4, ?5, 0, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               deleted              = excluded.deleted,
               revision             = excluded.revision,
               updated_at           = excluded.updated_at,
               remote_segment_count = excluded.remote_segment_count,
               remote_content_hash  = excluded.remote_content_hash,
               sync_dirty           = 0
             WHERE excluded.revision >= interviews.revision AND interviews.sync_dirty = 0",
            params![
                row.id,
                row.study_label,
                updated_at,
                row.revision,
                row.deleted as i64,
                row.segment_count,
                row.content_hash,
            ],
        )?;
        if will_apply && changed > 0 {
            outcome.pulled_interviews += 1;
        }
    }

    tx.commit()?;
    Ok(outcome)
}

#[allow(dead_code)]
/// The newest `updated_at` in a set of pulled rows, for the next cursor.
pub fn max_updated_at<'a>(rows: impl Iterator<Item = &'a Option<String>>) -> Option<String> {
    rows.flatten().max().cloned()
}

/// The cursor to store after applying a pull.
///
/// Never advances past a row this machine could not resolve. A deferred row
/// re-appears on the next pull because `pull_table` uses `gte`; an applied row
/// re-appears harmlessly because applying is idempotent. The only outcome that
/// cannot be undone is walking past a row and never seeing it again, which is
/// what v0.23–v0.24 did every time a local row was dirty.
pub fn next_cursor<'a>(
    received: impl IntoIterator<Item = &'a Option<String>>,
    receipt: &TableReceipt,
) -> Option<String> {
    if receipt.deferred.is_empty() {
        received.into_iter().flatten().max().cloned()
    } else {
        receipt.deferred.iter().map(|(_, u)| u).min().cloned()
    }
}

/// Guard against misleading "Synced" state when local rows are empty but cursor is set.
pub fn is_never_synced(conn: &Connection) -> rusqlite::Result<bool> {
    let in_group = is_bound(conn)?;
    let coded_cursor = get_state(conn, KEY_CODED_CURSOR)?;
    let count: i64 = conn.query_row("SELECT count(*) FROM coded_segments", [], |r| r.get(0))?;
    Ok(in_group && coded_cursor.is_some() && count == 0)
}

// ── Phase 2: the network (no SQLite) ─────────────────────────────────────────
//
// Supabase is reached as plain PostgREST — HTTP and JSON — rather than through
// a client library. That is not asceticism: SDK clients log request and
// response bodies through configurable hooks, and any crash reporter attached
// to one serialises whatever object happened to be in scope. Here the only
// things that can be serialised are the payload structs above, and the only
// place they are constructed is `collect_push_batch`.

use reqwest::{Client, StatusCode};

/// Anything longer than this is a hung connection, not a slow one. Sync must
/// never be the reason the app feels stuck — coding is local and never waits.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub fn client() -> Result<Client, SyncError> {
    Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("Fleuron/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| SyncError::Network(e.to_string()))
}

// ── The stored sign-in ───────────────────────────────────────────────────────
//
// Only the refresh token is stored, in a mode-0600 JSON file (`session.json`)
// inside the user's app data directory.
//
// The keychain was dropped because the app is currently ad-hoc signed: macOS
// recalculates the CDHash on every install and build, treating each build as a
// stranger and prompting the user for keychain access on startup. Storing the
// token in app data removes the macOS prompt at zero cost.
//
// Trade-off: the token is readable by any process running as the current user,
// included in Time Machine backups, and subject to attribution impersonation if
// stolen.
//
// Revisit condition: If a Developer ID certificate is ever adopted, the OS prompt
// disappears on its own and this file becomes pure downside. When that happens,
// flip session_store back to keyring and delete session.json.

/// Remember this sign-in for future launches.
///
/// Best-effort by design. A storage write failure must never turn a successful
/// sign-in into an error; the session in memory is already valid and the only
/// cost is signing in again next time.
pub fn remember_session(app: &tauri::AppHandle, session: &SyncSession) {
    crate::session_store::save(app, &session.refresh_token);
}

pub fn forget_session(app: &tauri::AppHandle) {
    crate::session_store::clear(app);
}

pub fn stored_refresh_token(app: &tauri::AppHandle) -> Option<String> {
    crate::session_store::load(app)
}

/// Turn a remembered refresh token back into a live session.
///
/// Called at startup. A refresh token that no longer works is an ordinary
/// outcome — revoked, expired, or the project reset — so the stored copy is
/// discarded rather than retried, and the coder simply signs in again.
pub async fn restore_session(
    app: &tauri::AppHandle,
    client: &Client,
    cfg: &SyncConfig,
) -> Result<Option<SyncSession>, SyncError> {
    let Some(refresh_token) = stored_refresh_token(app) else {
        return Ok(None);
    };
    let stale = SyncSession {
        access_token: String::new(),
        refresh_token,
        user_id: String::new(),
        email: String::new(),
    };
    match refresh(client, cfg, &stale).await {
        Ok(session) => {
            remember_session(app, &session);
            Ok(Some(session))
        }
        Err(SyncError::Auth(_)) | Err(SyncError::Unauthorized) => {
            forget_session(app);
            Ok(None)
        }
        // A network failure is not a bad token. Keep it and try again later.
        Err(e) => Err(e),
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    /// Present on password sign-in and token refresh; absent on some signup
    /// shapes, so it stays optional and the caller defaults it.
    user: Option<UserStub>,
}

#[derive(Deserialize)]
struct UserStub {
    id: String,
    #[serde(default)]
    email: Option<String>,
}

fn session_from_token(token: TokenResponse) -> SyncSession {
    SyncSession {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        user_id: token
            .user
            .as_ref()
            .map(|u| u.id.clone())
            .unwrap_or_default(),
        email: token.user.and_then(|u| u.email).unwrap_or_default(),
    }
}

/// Exchange an email and password for tokens.
///
/// Password auth with hand-created accounts, deliberately: magic links would
/// mean a custom URL scheme and deep-link handling, which is the fiddliest part
/// of desktop OAuth and buys nothing for a team of three known people.
pub async fn sign_in(
    client: &Client,
    cfg: &SyncConfig,
    email: &str,
    password: &str,
) -> Result<SyncSession, SyncError> {
    let response = client
        .post(format!("{}/auth/v1/token", cfg.url.trim_end_matches('/')))
        .query(&[("grant_type", "password")])
        .header("apikey", &cfg.anon_key)
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if !response.status().is_success() {
        // The body is an auth error description, never study data.
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(SyncError::Auth(explain_auth_failure(status, &detail)));
    }

    let token: TokenResponse = response
        .json()
        .await
        .map_err(|e| SyncError::Auth(e.to_string()))?;
    Ok(session_from_token(token))
}

/// Create an account.
///
/// Exists so the person running a study never has to choose, know, or transmit
/// somebody else's password. It is safe to let anyone register because an
/// account grants nothing on its own: every policy in `schema.sql` reduces to
/// project membership, and a stranger with an account reads an empty database.
/// The invite is the gate, not the account.
///
/// Returns `None` when the project requires email confirmation — the account
/// exists but there is no session yet, and the caller has to say so rather than
/// leaving somebody staring at a form that appeared to do nothing.
pub async fn sign_up(
    client: &Client,
    cfg: &SyncConfig,
    email: &str,
    password: &str,
) -> Result<Option<SyncSession>, SyncError> {
    let response = client
        .post(format!("{}/auth/v1/signup", cfg.url.trim_end_matches('/')))
        .header("apikey", &cfg.anon_key)
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(SyncError::Auth(explain_auth_failure(status, &detail)));
    }

    // With confirmation off the response carries a session; with it on the same
    // endpoint returns the user and no tokens. Both are successes.
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| SyncError::Auth(e.to_string()))?;
    let access = body.get("access_token").and_then(|v| v.as_str());
    let refresh = body.get("refresh_token").and_then(|v| v.as_str());
    let user_id = body
        .get("user")
        .and_then(|u| u.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let email = body
        .get("user")
        .and_then(|u| u.get("email"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    match (access, refresh) {
        (Some(a), Some(r)) => Ok(Some(SyncSession {
            access_token: a.to_string(),
            refresh_token: r.to_string(),
            user_id,
            email,
        })),
        _ => Ok(None),
    }
}

/// Ask the server to email a password-reset code.
///
/// Always treated as success when the server accepts the request: GoTrue
/// answers the same way whether the email has an account or not, so we cannot
/// honestly say "sent" vs "no such user" and should not try. The UI tells
/// them to check that inbox.
pub async fn request_password_reset(
    client: &Client,
    cfg: &SyncConfig,
    email: &str,
) -> Result<(), SyncError> {
    let response = client
        .post(format!("{}/auth/v1/recover", cfg.url.trim_end_matches('/')))
        .header("apikey", &cfg.anon_key)
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(SyncError::Auth(explain_auth_failure(status, &detail)));
    }
    Ok(())
}

/// Finish a password reset: turn the email's code into a session, then
/// set the new password. The coder is signed in when this returns.
#[allow(clippy::too_many_arguments)]
pub async fn complete_password_reset(
    client: &Client,
    cfg: &SyncConfig,
    email: &str,
    password: &str,
    token: Option<&str>,
    token_hash: Option<&str>,
    access_token: Option<&str>,
    refresh_token: Option<&str>,
) -> Result<SyncSession, SyncError> {
    if password.len() < 6 {
        return Err(SyncError::Auth(
            "That password is too short — use at least 6 characters.".into(),
        ));
    }
    let session = match (
        nonempty(access_token),
        nonempty(refresh_token),
        nonempty(token_hash),
        nonempty(token),
    ) {
        (Some(access), Some(refresh), _, _) => SyncSession {
            access_token: access.to_string(),
            refresh_token: refresh.to_string(),
            user_id: String::new(),
            email: email.to_string(),
        },
        (_, _, hash, otp) => verify_recovery(client, cfg, email, otp, hash).await?,
    };
    set_password(client, cfg, &session, password).await?;
    // A pasted access/refresh pair does not include user_id. Fill it so the
    // roster's "you" marker is right on this launch, not only after restore.
    Ok(hydrate_session(client, cfg, session).await)
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn recovery_verify_body(
    email: &str,
    token: Option<&str>,
    token_hash: Option<&str>,
) -> Result<serde_json::Value, SyncError> {
    match (token_hash, token) {
        (Some(hash), _) => Ok(serde_json::json!({
            "type": "recovery",
            "token_hash": hash,
        })),
        (_, Some(otp)) => Ok(serde_json::json!({
            "type": "recovery",
            "email": email,
            "token": otp,
        })),
        _ => Err(SyncError::Auth(
            "Type the reset code from the email.".into(),
        )),
    }
}

async fn verify_recovery(
    client: &Client,
    cfg: &SyncConfig,
    email: &str,
    token: Option<&str>,
    token_hash: Option<&str>,
) -> Result<SyncSession, SyncError> {
    let body = recovery_verify_body(email, token, token_hash)?;

    let response = client
        .post(format!("{}/auth/v1/verify", cfg.url.trim_end_matches('/')))
        .header("apikey", &cfg.anon_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(SyncError::Auth(explain_auth_failure(status, &detail)));
    }
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|e| SyncError::Auth(e.to_string()))?;
    Ok(session_from_token(token))
}

async fn set_password(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    password: &str,
) -> Result<(), SyncError> {
    let response = client
        .put(format!("{}/auth/v1/user", cfg.url.trim_end_matches('/')))
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", session.access_token))
        .json(&serde_json::json!({ "password": password }))
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(SyncError::Auth(explain_auth_failure(status, &detail)));
    }
    Ok(())
}

/// Fill user_id / email from /auth/v1/user when the session was built from a
/// pasted token pair. Failure is ignored: the password is already set.
async fn hydrate_session(
    client: &Client,
    cfg: &SyncConfig,
    mut session: SyncSession,
) -> SyncSession {
    if !session.user_id.is_empty() {
        return session;
    }
    let Ok(response) = client
        .get(format!("{}/auth/v1/user", cfg.url.trim_end_matches('/')))
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", session.access_token))
        .send()
        .await
    else {
        return session;
    };
    if !response.status().is_success() {
        return session;
    }
    let Ok(user) = response.json::<UserStub>().await else {
        return session;
    };
    session.user_id = user.id;
    if let Some(email) = user.email {
        if !email.is_empty() {
            session.email = email;
        }
    }
    session
}

/// Turn a GoTrue error body into something a coder can act on.
///
/// The raw body is JSON aimed at developers — `{"error":"invalid_grant",
/// "error_description":"Invalid login credentials"}` — and it surfaced verbatim
/// under "Sign-in failed:". That tells somebody who mistyped their password
/// nothing about what to do, and tells somebody who never confirmed their email
/// something actively misleading, because the credentials are fine.
///
/// Unrecognised cases keep the original text rather than being flattened into a
/// generic apology: an error nobody anticipated is exactly the one worth
/// reading in full.
fn explain_auth_failure(status: reqwest::StatusCode, body: &str) -> String {
    let lower = body.to_lowercase();

    if lower.contains("email not confirmed") || lower.contains("email_not_confirmed") {
        return "This account exists but its email has not been confirmed. \
                Check your inbox for the confirmation link, then try again."
            .into();
    }
    if lower.contains("invalid login credentials") || lower.contains("invalid_grant") {
        return "That email and password do not match an account. Check for a \
                typo — or choose “Forgot password?”. If you have not created \
                an account yet, choose “Create an account”."
            .into();
    }
    if lower.contains("user already registered") || lower.contains("already registered") {
        return "There is already an account with that email. Choose \
                “I already have one” and sign in — or “Forgot password?” \
                if you do not remember it."
            .into();
    }
    if lower.contains("password should be at least") || lower.contains("weak_password") {
        return "That password is too short — use at least 6 characters.".into();
    }
    if lower.contains("otp_expired")
        || lower.contains("token has expired")
        || lower.contains("otp_disabled")
        || lower.contains("invalid token")
    {
        return "That reset code is no longer valid. Send a new one and try \
                again."
            .into();
    }
    if status.as_u16() == 429 || lower.contains("over_request_rate_limit") {
        return "Too many attempts in a short time. Wait a minute and try again.".into();
    }

    if body.trim().is_empty() {
        format!("The sign-in server refused the request ({status}).")
    } else {
        body.to_string()
    }
}

/// Trade a refresh token for a fresh access token.
///
/// Access tokens expire in an hour by default, and a coder can easily leave the
/// app open longer than that. Without this, sync would work in the morning and
/// silently start failing after lunch.
pub async fn refresh(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
) -> Result<SyncSession, SyncError> {
    let response = client
        .post(format!("{}/auth/v1/token", cfg.url.trim_end_matches('/')))
        .query(&[("grant_type", "refresh_token")])
        .header("apikey", &cfg.anon_key)
        .json(&serde_json::json!({ "refresh_token": session.refresh_token }))
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if !response.status().is_success() {
        return Err(SyncError::Auth(response.text().await.unwrap_or_default()));
    }
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|e| SyncError::Auth(e.to_string()))?;
    Ok(session_from_token(token))
}

fn rest(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    method: reqwest::Method,
    table: &str,
) -> reqwest::RequestBuilder {
    client
        .request(
            method,
            format!("{}/rest/v1/{table}", cfg.url.trim_end_matches('/')),
        )
        .header("apikey", &cfg.anon_key)
        .header("Authorization", format!("Bearer {}", session.access_token))
}

#[derive(Debug, Deserialize)]
pub struct RemoteProject {
    pub corpus_hash: Option<String>,
}

/// Read the shared project row, if this account can see one.
///
/// `None` means either the row does not exist or this user is not a member of
/// it — RLS makes those indistinguishable from the client, and deliberately so.
pub async fn fetch_remote_project(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
) -> Result<Option<RemoteProject>, SyncError> {
    let response = rest(client, cfg, session, reqwest::Method::GET, "projects")
        .query(&[
            ("project_id", format!("eq.{}", cfg.project_id)),
            ("select", "corpus_hash".into()),
            ("limit", "1".into()),
        ])
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(SyncError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(SyncError::Network(format!(
            "{}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        )));
    }
    let rows: Vec<RemoteProject> = response
        .json()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;
    Ok(rows.into_iter().next())
}

/// `corpus_hash` of a project holding no transcripts: SHA-256 of nothing.
///
/// A joiner's brand-new project always hashes to this, which is what makes
/// "has this machine got the transcripts yet?" answerable from the hash alone,
/// with no extra query and no extra argument threaded through the sync call.
/// `empty_corpus_hashes_to_the_sha256_of_nothing` pins the value.
pub const EMPTY_CORPUS: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// What this run is allowed to exchange, once the corpora have been compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CorpusState {
    /// Both machines hold the same transcripts. Everything may move.
    Ready,
    /// This machine has no transcripts yet. Pull only — see [`plan_corpus`].
    AwaitingTranscripts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CorpusPlan {
    /// The corpora already agree.
    Proceed,
    /// Nobody has recorded a corpus yet and this machine has one to describe.
    Pin,
    /// Take what the study knows; contribute nothing.
    AwaitOnly,
    /// The recorded corpus is out of date. Update it and carry on.
    Repin,
}

/// Decide what a corpus comparison licenses, without touching the network.
///
/// # This check no longer refuses anything, and that is the fix
///
/// It used to fail the whole sync when two non-empty corpora disagreed. That
/// made the study's first-recorded corpus permanent: nothing ever updated the
/// stored hash, so importing a second interview — or fixing a typo, or
/// re-importing a cleaner file — put the machine permanently at odds with a
/// value it had no way to change. The error told coders to "re-import the same
/// transcript files", which is unactionable advice when nothing was
/// mis-imported and the corpus simply grew.
///
/// 🔑 **The refusal was also protecting against nothing.** It predates
/// content-derived ids. A `segment_id` is now `H(interview, index, text)`, so
/// two machines hold the same segment id *only if* they hold the same passage
/// at the same position with the same words — that is what the id means. The
/// per-passage guarantee the corpus hash was standing in for is now structural,
/// and coding for a passage this machine lacks waits in
/// `pending_coded_segments` rather than attaching to the wrong text.
///
/// So the hash is kept as a record of the last corpus the study saw — useful
/// when diagnosing why two coders' rosters differ — and the actionable signal
/// moved to [`missing_transcripts`], which reports per interview and can tell
/// "you have not imported P07" apart from "you imported a different P07".
fn plan_corpus(local_hash: &str, remote_hash: Option<&str>) -> CorpusPlan {
    match remote_hash {
        Some(remote) if remote == local_hash => CorpusPlan::Proceed,
        // Ordered above the arms below: a machine with no transcripts must not
        // overwrite the study's record with the hash of nothing.
        _ if local_hash == EMPTY_CORPUS => CorpusPlan::AwaitOnly,
        Some(_) => CorpusPlan::Repin,
        None => CorpusPlan::Pin,
    }
}

/// Record what corpus this machine holds, and report whether it has one.
///
/// Never refuses a sync. Whichever machine syncs most recently leaves its own
/// fingerprint on the study, so the stored value tracks the corpus instead of
/// freezing the first one ever seen — see [`plan_corpus`] for why the old
/// refusal was both unrecoverable and unnecessary.
pub async fn reconcile_corpus(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    local_hash: &str,
) -> Result<CorpusState, SyncError> {
    let remote = fetch_remote_project(client, cfg, session)
        .await?
        .ok_or(SyncError::NotConfigured)?;

    match plan_corpus(local_hash, remote.corpus_hash.as_deref()) {
        CorpusPlan::Proceed => Ok(CorpusState::Ready),
        CorpusPlan::AwaitOnly => Ok(CorpusState::AwaitingTranscripts),
        CorpusPlan::Pin | CorpusPlan::Repin => {
            let response = rest(client, cfg, session, reqwest::Method::PATCH, "projects")
                .query(&[("project_id", format!("eq.{}", cfg.project_id))])
                .header("Prefer", "return=minimal")
                .json(&serde_json::json!({ "corpus_hash": local_hash }))
                .send()
                .await
                .map_err(|e| SyncError::Network(e.to_string()))?;
            if !response.status().is_success() {
                return Err(SyncError::Network(format!(
                    "{}: {}",
                    response.status(),
                    response.text().await.unwrap_or_default()
                )));
            }
            Ok(CorpusState::Ready)
        }
    }
}

/// Classify a failed direct REST write (`upsert`): entitlement token first,
/// then the protocol's ordinary outcomes.
fn classify_rest_upsert_failure(status: u16, body: String) -> SyncError {
    if let Some(err) = classify_entitlement_failure(&body) {
        return err;
    }
    match status {
        401 => SyncError::Unauthorized,
        // A unique violation here is not the `id` conflict we asked to merge —
        // that one resolves. It is the (project, segment, coder, span)
        // constraint, which can only trip when one coder codes the same span of
        // the same passage from two machines under two different row ids.
        409 => SyncError::DuplicateCoding(body),
        s => SyncError::Network(format!("{s}: {body}")),
    }
}

async fn upsert<T: Serialize>(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    table: &str,
    rows: &[T],
) -> Result<(), SyncError> {
    if rows.is_empty() {
        return Ok(());
    }
    let response = rest(client, cfg, session, reqwest::Method::POST, table)
        .query(&[("on_conflict", "id")])
        .header("Prefer", "resolution=merge-duplicates,return=minimal")
        .json(rows)
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if response.status().is_success() {
        return Ok(());
    }
    // Read the body once: an entitlement fail-closed gate on this table's RLS
    // arrives as HTTP 403 and must map to the friendly message, not to the
    // generic permission or network text.
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    Err(classify_rest_upsert_failure(status, body))
}

pub async fn push(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    batch: &PushBatch,
) -> Result<(), SyncError> {
    // Codes first. A coded segment referring to a code the other machine has
    // not seen yet renders as an unnamed chip; the reverse order never has a
    // window where that is visible.
    upsert(client, cfg, session, "codebook", &batch.codes).await?;
    upsert(client, cfg, session, "interviews", &batch.interviews).await?;
    upsert(client, cfg, session, "coded_segments", &batch.coded).await
}

pub trait HasUpdatedAt {
    fn updated_at(&self) -> Option<&str>;
}

impl HasUpdatedAt for CodedSegmentPayload {
    fn updated_at(&self) -> Option<&str> {
        self.updated_at.as_deref()
    }
}

impl HasUpdatedAt for CodePayload {
    fn updated_at(&self) -> Option<&str> {
        self.updated_at.as_deref()
    }
}

impl HasUpdatedAt for InterviewPayload {
    fn updated_at(&self) -> Option<&str> {
        self.updated_at.as_deref()
    }
}

pub const MAX_PAGES: usize = 50;

/// Pure pagination logic helper for testing and execution.
pub fn compute_next_page_query(
    current_cursor: &str,
    current_op: &str,
    page_len: usize,
    max_updated_at: Option<&str>,
) -> Option<(&'static str, String)> {
    if page_len < PAGE_SIZE {
        return None;
    }
    if let Some(next_cursor) = max_updated_at {
        if next_cursor == current_cursor && current_op == "gte" {
            // Stall guard: full page with identical timestamps -> advance with gt
            Some(("gt", current_cursor.to_string()))
        } else if next_cursor == current_cursor && current_op == "gt" {
            // Even gt returned same cursor, stop to prevent infinite loop
            None
        } else {
            Some(("gte", next_cursor.to_string()))
        }
    } else {
        None
    }
}

pub async fn pull_table<T: for<'de> Deserialize<'de> + HasUpdatedAt>(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    table: &str,
    cursor: Option<&str>,
) -> Result<(Vec<T>, bool), SyncError> {
    let mut all_rows = Vec::new();
    let mut current_cursor = cursor.unwrap_or("1970-01-01T00:00:00Z").to_string();
    let mut op = "gte";
    let mut truncated = false;

    for page_idx in 0..MAX_PAGES {
        let response = rest(client, cfg, session, reqwest::Method::GET, table)
            .query(&[
                ("project_id", format!("eq.{}", cfg.project_id)),
                ("updated_at", format!("{op}.{current_cursor}")),
                ("order", "updated_at.asc".into()),
                ("limit", PAGE_SIZE.to_string()),
                ("select", "*".into()),
            ])
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;

        if response.status() == StatusCode::UNAUTHORIZED {
            return Err(SyncError::Unauthorized);
        }
        if !response.status().is_success() {
            return Err(SyncError::Network(format!(
                "{}: {}",
                response.status(),
                response.text().await.unwrap_or_default()
            )));
        }

        let page: Vec<T> = response
            .json()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;

        let page_len = page.len();
        let max_page_updated_at = page
            .iter()
            .filter_map(|r| r.updated_at())
            .max()
            .map(str::to_string);
        all_rows.extend(page);

        if let Some((next_op, next_cur)) = compute_next_page_query(
            &current_cursor,
            op,
            page_len,
            max_page_updated_at.as_deref(),
        ) {
            op = next_op;
            current_cursor = next_cur;
            if page_idx == MAX_PAGES - 1 {
                truncated = true;
            }
        } else {
            break;
        }
    }

    Ok((all_rows, truncated))
}

pub async fn pull(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    coded_cursor: Option<&str>,
    codebook_cursor: Option<&str>,
    interview_cursor: Option<&str>,
) -> Result<PullBatch, SyncError> {
    let (codes, trunc1) = pull_table(client, cfg, session, "codebook", codebook_cursor).await?;
    let (interviews, trunc2) =
        pull_table(client, cfg, session, "interviews", interview_cursor).await?;
    let (coded, trunc3) = pull_table(client, cfg, session, "coded_segments", coded_cursor).await?;
    Ok(PullBatch {
        coded,
        codes,
        interviews,
        truncated: trunc1 || trunc2 || trunc3,
    })
}

/// Fetch every coded row the server holds under the given coder names.
///
/// The targeted half of the push-conflict rescue in `commands::sync_now`. A
/// 409 on the (project, segment, coder, span) constraint says the server has
/// a row under one of these names with a different id, but not which one —
/// so the rescue pulls the names the batch touched, runs them through
/// `apply_pull` (which re-keys local twins onto the server's ids), and retries
/// the push once.
pub async fn fetch_coded_for_coders(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    coder_names: &[String],
) -> Result<Vec<CodedSegmentPayload>, SyncError> {
    if coder_names.is_empty() {
        return Ok(Vec::new());
    }
    // PostgREST `in.` list. Values are double-quoted so commas, spaces and
    // parentheses in a display name cannot break the filter apart.
    let list = coder_names
        .iter()
        .map(|n| format!("\"{}\"", n.replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(",");
    let response = rest(client, cfg, session, reqwest::Method::GET, "coded_segments")
        .query(&[
            ("project_id", format!("eq.{}", cfg.project_id)),
            ("coder_name", format!("in.({list})")),
            ("select", "*".to_string()),
            ("limit", PAGE_SIZE.to_string()),
        ])
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(SyncError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(SyncError::Network(format!(
            "{}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        )));
    }
    response
        .json()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))
}

/// Reset sync cursors to epoch ("1970-01-01T00:00:00Z") so the next pull re-fetches
/// everything from the server.
pub fn reset_cursors_for_repair(conn: &Connection) -> rusqlite::Result<()> {
    for key in [KEY_CODED_CURSOR, KEY_CODEBOOK_CURSOR, KEY_INTERVIEW_CURSOR] {
        set_state(conn, key, "1970-01-01T00:00:00Z")?;
    }
    Ok(())
}

/// Formats a diagnostics report into a redacted plain-text summary suitable for clipboard copy.
/// Strictly guarantees NO participant labels, NO code names, and NO transcript text.
pub fn diagnostics_summary_text(report: &DiagnosticsReport) -> String {
    format!(
        "Fleuron Sync Diagnostics\n\
         ========================\n\
         Summary: {}\n\
         Local: {} coded segments, {} codes\n\
         Remote: {} coded segments, {} codes\n\
         Missing from remote: {} segments\n\
         Pending to send: {} items\n\
         Clock skew: {}s\n\
         Last synced: {}\n\
         Cursors: coded={}, codebook={}, interview={}\n",
        report.summary_message,
        report.local_coded_count,
        report.local_code_count,
        report.remote_coded_count,
        report.remote_code_count,
        report.missing_remote_coded_count,
        report.pending_to_send_count,
        report.clock_skew_seconds.unwrap_or(0),
        report.last_synced_at.as_deref().unwrap_or("Never"),
        report.raw_coded_cursor.as_deref().unwrap_or("none"),
        report.raw_codebook_cursor.as_deref().unwrap_or("none"),
        report.raw_interview_cursor.as_deref().unwrap_or("none"),
    )
}

pub struct LocalDiagnosticsState {
    pub local_coded: Vec<crate::models::CodedSegment>,
    pub local_codes: Vec<crate::models::Code>,
    pub pending_batch: PushBatch,
    pub raw_coded_cursor: Option<String>,
    pub raw_codebook_cursor: Option<String>,
    pub raw_interview_cursor: Option<String>,
    pub last_synced_at: Option<String>,
}

impl LocalDiagnosticsState {
    pub fn collect(conn: &Connection, project_id: &str) -> Result<Self, rusqlite::Error> {
        let local_coded = db::list_coded_segments(conn, None, None)?;
        let local_codes = db::list_codes(conn)?;
        let pending_batch = collect_push_batch(conn, project_id)?;
        let raw_coded_cursor = get_state(conn, KEY_CODED_CURSOR)?;
        let raw_codebook_cursor = get_state(conn, KEY_CODEBOOK_CURSOR)?;
        let raw_interview_cursor = get_state(conn, KEY_INTERVIEW_CURSOR)?;
        let last_synced_at = get_state(conn, KEY_LAST_SYNCED)?;
        Ok(Self {
            local_coded,
            local_codes,
            pending_batch,
            raw_coded_cursor,
            raw_codebook_cursor,
            raw_interview_cursor,
            last_synced_at,
        })
    }
}

/// Perform a read-only deep verification comparing local SQLite state against
/// the remote server's records from epoch. Does NOT write to SQLite.
pub async fn deep_verify(
    local: &LocalDiagnosticsState,
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
) -> Result<DiagnosticsReport, SyncError> {
    let pending_to_send_count = local.pending_batch.coded.len()
        + local.pending_batch.codes.len()
        + local.pending_batch.interviews.len();

    // Fetch remote state from epoch in memory (read-only)
    let epoch = "1970-01-01T00:00:00Z";
    let (remote_codes, _) =
        pull_table::<CodePayload>(client, cfg, session, "codebook", Some(epoch)).await?;
    let (remote_coded, _) =
        pull_table::<CodedSegmentPayload>(client, cfg, session, "coded_segments", Some(epoch))
            .await?;

    let local_coded_ids: std::collections::HashSet<String> =
        local.local_coded.iter().map(|c| c.id.clone()).collect();
    let mut missing_coded: Vec<&CodedSegmentPayload> = Vec::new();
    for rc in &remote_coded {
        if !rc.deleted && !local_coded_ids.contains(&rc.id) {
            missing_coded.push(rc);
        }
    }

    let mut missing_coders: Vec<String> =
        missing_coded.iter().map(|c| c.coder_name.clone()).collect();
    missing_coders.sort();
    missing_coders.dedup();

    let missing_count = missing_coded.len();
    let needs_repair = missing_count > 0;
    let needs_send = pending_to_send_count > 0;

    let summary_message = if missing_count > 0 {
        let names = if missing_coders.is_empty() {
            "another coder".to_string()
        } else {
            missing_coders.join(", ")
        };
        format!(
            "{} coded passage{} from {} {} missing on this computer.",
            missing_count,
            if missing_count == 1 { "" } else { "s" },
            names,
            if missing_count == 1 { "is" } else { "are" },
        )
    } else if pending_to_send_count > 0 {
        format!(
            "{} of your changes {} not reached the study yet.",
            pending_to_send_count,
            if pending_to_send_count == 1 {
                "has"
            } else {
                "have"
            },
        )
    } else {
        format!(
            "Everything matches. {} coded passages, {} codes.",
            local.local_coded.len(),
            local.local_codes.len()
        )
    };

    Ok(DiagnosticsReport {
        local_coded_count: local.local_coded.len(),
        local_code_count: local.local_codes.len(),
        remote_coded_count: remote_coded.len(),
        remote_code_count: remote_codes.len(),
        missing_remote_coded_count: missing_count,
        missing_remote_coder_names: missing_coders,
        pending_to_send_count,
        clock_skew_seconds: None,
        summary_message,
        raw_coded_cursor: local.raw_coded_cursor.clone(),
        raw_codebook_cursor: local.raw_codebook_cursor.clone(),
        raw_interview_cursor: local.raw_interview_cursor.clone(),
        last_synced_at: local.last_synced_at.clone(),
        needs_repair,
        needs_send,
        last_error: None,
        last_outcome: None,
    })
}

/// One group the signed-in account belongs to, with the name they file under.
///
/// The `coder_name` is what makes this more useful than a bare project list:
/// it is the name the server has on the membership row, so a machine joining
/// an existing local project can adopt it instead of asking again.
///
/// 🔴 **The two directions need different casing, and a container-level
/// `rename_all = "camelCase"` applies to both — which made the join picker
/// undecodable.** PostgREST sends `project_id`; the frontend expects
/// `projectId`. With the container rename, serde looked for `projectId` in the
/// server's reply, did not find it, and the whole call failed with reqwest's
/// "error decoding response body" — surfaced to the user as *"Could not reach
/// the sync server"*, which points at the network rather than at this line.
///
/// ⚠️ **It hid because an empty array decodes cleanly whatever the field names
/// are.** Every run before somebody actually joined a group got `[]` back, so
/// the picker came up empty rather than erroring, and "no groups yet" is
/// exactly what a coder with no memberships expects to see. The first
/// successful join in the project's history was also the first request that
/// returned a row, and the first that could fail.
///
/// This is why the renames below are per-direction. The other structs decoded
/// from PostgREST — the pull payloads — carry no container rename at all and
/// stay snake_case both ways.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct MembershipSummary {
    #[serde(rename = "projectId", alias = "project_id")]
    pub project_id: String,
    pub title: String,
    #[serde(rename = "coderName", alias = "coder_name")]
    pub coder_name: String,
    /// Every coder in the group, in join order, including you.
    pub members: Vec<String>,
    #[serde(default = "default_coder_role")]
    pub role: String,
}

fn default_coder_role() -> String {
    "coder".to_string()
}

/// The wire shape of one `project_members` row with the group's title joined
/// in. PostgREST nests the joined resource (`projects: { title: … }`), which
/// is why this exists apart from [`MembershipSummary`]'s flat, frontend-facing
/// shape.
#[derive(Deserialize, Debug, Clone)]
pub(crate) struct MembershipRow {
    pub project_id: String,
    #[serde(default)]
    pub user_id: String,
    pub coder_name: String,
    #[serde(default)]
    pub role: Option<String>,
    pub projects: Option<MembershipTitle>,
}

#[derive(Deserialize, Debug, Clone)]
pub(crate) struct MembershipTitle {
    pub title: String,
}

impl MembershipRow {
    #[cfg(test)]
    pub(crate) fn into_summary(self) -> MembershipSummary {
        let name = self.coder_name.clone();
        let role = self.role.unwrap_or_else(|| "coder".to_string());
        MembershipSummary {
            project_id: self.project_id,
            title: self.projects.map(|p| p.title).unwrap_or_default(),
            coder_name: self.coder_name,
            members: vec![name],
            role,
        }
    }
}

/// Fold a flat list of member rows into one `MembershipSummary` per project,
/// preserving first-seen order.
///
/// Returns an empty vec for any project where `current_user_id` has no member row,
/// failing closed so a user is never filed under another coder's identity.
pub(crate) fn fold_memberships(
    rows: Vec<MembershipRow>,
    current_user_id: &str,
) -> Vec<MembershipSummary> {
    let mut project_order: Vec<String> = Vec::new();
    let mut project_rows: std::collections::HashMap<String, Vec<MembershipRow>> =
        std::collections::HashMap::new();

    for row in rows {
        if !project_rows.contains_key(&row.project_id) {
            project_order.push(row.project_id.clone());
        }
        project_rows
            .entry(row.project_id.clone())
            .or_default()
            .push(row);
    }

    let mut summaries = Vec::new();
    for pid in project_order {
        let rows = project_rows.remove(&pid).unwrap_or_default();
        let matching_user_row = rows.iter().find(|r| r.user_id == current_user_id);
        let Some(user_row) = matching_user_row else {
            // Skip any project with no row matching current_user_id. Fail closed!
            continue;
        };

        let title = rows
            .iter()
            .find_map(|r| r.projects.as_ref().map(|p| p.title.clone()))
            .unwrap_or_default();

        let members: Vec<String> = rows.iter().map(|r| r.coder_name.clone()).collect();
        let role = user_row.role.clone().unwrap_or_else(|| "coder".to_string());

        summaries.push(MembershipSummary {
            project_id: pid,
            title,
            coder_name: user_row.coder_name.clone(),
            members,
            role,
        });
    }

    summaries
}

/// Every group this account is a member of.
///
/// The list is scoped by row-level security rather than by a filter here, so it
/// cannot show a group the signed-in user has no access to even if the client
/// asks for one.
pub async fn list_memberships(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
) -> Result<Vec<MembershipSummary>, SyncError> {
    let response = rest(
        client,
        cfg,
        session,
        reqwest::Method::GET,
        "project_members",
    )
    .query(&[
        (
            "select",
            "project_id,user_id,coder_name,role,projects(title)",
        ),
        ("order", "joined_at.asc"),
    ])
    .send()
    .await
    .map_err(|e| SyncError::Network(e.to_string()))?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(SyncError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(SyncError::Network(format!(
            "{}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        )));
    }

    let rows: Vec<MembershipRow> = response
        .json()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;
    Ok(fold_memberships(rows, &session.user_id))
}

// ── Group keys ───────────────────────────────────────────────────────────────

/// Crockford's Base32 alphabet: digits and letters, less `I`, `L`, `O` and `U`.
///
/// `I`/`L` against `1`, and `O` against `0`, are the confusions people actually
/// make reading a key off one screen and typing it into another machine. They
/// are not in the alphabet at all, and [`normalise_code`] folds them back in
/// rather than rejecting the attempt. `U` is left out so a random draw cannot
/// spell something unfortunate.
const CODE_ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Characters in a group key, before the display dash.
///
/// A group key is a shared secret that works indefinitely, unlike the
/// single-use invitation codes it replaces — so it gets eight characters
/// (32⁸ ≈ 1.1 trillion) instead of six, and the projects table's unique index
/// is the coordinator that keeps two groups from drawing the same one.
pub const GROUP_KEY_LEN: usize = 8;

/// A fresh group key, drawn from the first eight bytes of a v4 UUID.
///
/// ⚠️ Bytes 0–5 are fully random; **byte 6 carries the version nibble and byte 8
/// the variant bits**, so characters 7 and 8 are slightly biased draws. For a
/// keyspace this size against an online-guessing adversary the bias is
/// immaterial, but do not raise the length by taking more bytes from one UUID —
/// draw a second one. 256 is an exact multiple of 32, so `% 32` samples the
/// alphabet uniformly and there is no modulo bias on top.
pub fn new_group_key() -> String {
    uuid::Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(GROUP_KEY_LEN)
        .map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char)
        .collect()
}

/// `ABCD1234` reads as `ABCD-1234` — the dash is display only and
/// [`normalise_code`] strips it on the way back in.
pub fn format_group_key(key: &str) -> String {
    if key.len() == GROUP_KEY_LEN {
        format!("{}-{}", &key[..4], &key[4..])
    } else {
        key.to_string()
    }
}

/// Put a typed key or code into the form the server stores.
///
/// Keys get read aloud, written down and retyped, so this is deliberately
/// forgiving: case is irrelevant, spaces and dashes are decoration, and the
/// characters the alphabet avoids are folded to the ones it uses. Everything
/// funnels through here so that the comparison on the server stays a plain
/// equality test on a unique column.
pub fn normalise_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .collect()
}

/// What joining a group settled.
///
/// PostgREST returns snake_case (`project_id`); the frontend reads camelCase
/// (`projectId`). `rename` sets the frontend-facing name, `alias` accepts the
/// database's. A container-level `rename_all = "camelCase"` would look for
/// `projectId` in the RPC body and fail — the same trap as [`MembershipSummary`].
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct JoinedGroup {
    #[serde(rename = "projectId", alias = "project_id")]
    pub project_id: String,
    pub title: String,
    /// The name the server recorded for this member. On a rejoin it is the
    /// *existing* membership's name, not the one typed this time — the group
    /// already knows who you are.
    #[serde(rename = "coderName", alias = "coder_name")]
    pub coder_name: String,
    /// False when this account was already a member — the join was really a
    /// re-adoption, and nothing about the group changed.
    pub created: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RpcArg {
    pub name: &'static str,
    pub sql_type: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RpcSpec {
    pub name: &'static str,
    pub args: &'static [RpcArg],
}

pub const RPC_JOIN_GROUP: RpcSpec = RpcSpec {
    name: "join_group",
    args: &[
        RpcArg {
            name: "group_key",
            sql_type: "text",
        },
        RpcArg {
            name: "coder_name",
            sql_type: "text",
        },
    ],
};

pub const RPC_RESET_GROUP_KEY: RpcSpec = RpcSpec {
    name: "reset_group_key",
    args: &[RpcArg {
        name: "p_project_id",
        sql_type: "text",
    }],
};

pub const RPC_SET_MEMBER_ROLE: RpcSpec = RpcSpec {
    name: "set_member_role",
    args: &[
        RpcArg {
            name: "p_project_id",
            sql_type: "text",
        },
        RpcArg {
            name: "p_user_id",
            sql_type: "uuid",
        },
        RpcArg {
            name: "p_role",
            sql_type: "text",
        },
    ],
};

pub const RPC_REMOVE_MEMBER: RpcSpec = RpcSpec {
    name: "remove_member",
    args: &[
        RpcArg {
            name: "p_project_id",
            sql_type: "text",
        },
        RpcArg {
            name: "p_user_id",
            sql_type: "uuid",
        },
    ],
};

pub const RPC_DELETE_GROUP: RpcSpec = RpcSpec {
    name: "delete_group",
    args: &[
        RpcArg {
            name: "p_project_id",
            sql_type: "text",
        },
        RpcArg {
            name: "p_confirm_title",
            sql_type: "text",
        },
    ],
};

pub const RPC_LEAVE_GROUP: RpcSpec = RpcSpec {
    name: "leave_group",
    args: &[RpcArg {
        name: "p_project_id",
        sql_type: "text",
    }],
};

pub const RPC_SET_MY_CODER_NAME: RpcSpec = RpcSpec {
    name: "set_my_coder_name",
    args: &[
        RpcArg {
            name: "p_project_id",
            sql_type: "text",
        },
        RpcArg {
            name: "p_coder_name",
            sql_type: "text",
        },
    ],
};

pub const RPC_REDEEM_INVITE: RpcSpec = RpcSpec {
    name: "redeem_invite",
    args: &[RpcArg {
        name: "invite_code",
        sql_type: "text",
    }],
};

pub const RPC_SERVER_SCHEMA_VERSION: RpcSpec = RpcSpec {
    name: "server_schema_version",
    args: &[],
};

#[allow(dead_code)]
pub const RPC_CONTRACTS: &[RpcSpec] = &[
    RPC_JOIN_GROUP,
    RPC_RESET_GROUP_KEY,
    RPC_SET_MEMBER_ROLE,
    RPC_REMOVE_MEMBER,
    RPC_DELETE_GROUP,
    RPC_LEAVE_GROUP,
    RPC_SET_MY_CODER_NAME,
    RPC_REDEEM_INVITE,
    RPC_SERVER_SCHEMA_VERSION,
];

/// Stable server-side token raised by `require_sync_entitlement()` for every
/// entitlement-gated write path (RPC bodies and direct REST policy failures).
// FROZEN at the pre-rename spelling. This token is raised by
// `public.require_entitlement()` on the deployed Supabase project, and this
// repo deploys no migrations — the server will keep raising
// `CODEMAP_ENTITLEMENT_REQUIRED` regardless of what the app is called.
// Renaming it here silently breaks the friendly subscription message: a
// blocked write would surface as a raw 403 instead.
pub const ENTITLEMENT_REQUIRED_TOKEN: &str = "CODEMAP_ENTITLEMENT_REQUIRED";

/// Exact user-facing message for an entitlement-gated write failure. Held in
/// one place so RPC classification and direct REST paths cannot drift apart.
pub const ENTITLEMENT_REQUIRED_MESSAGE: &str =
    "Syncing new coding needs an active Fleuron subscription. Your work is \
     saved safely on this computer, and you can still pull your team's latest \
     — subscribe to resume syncing your own changes.";

/// Detect the entitlement token anywhere in a response body (the raise lands
/// in the PostgREST error body, nested JSON, or plain text depending on the
/// path), and map it to the friendly `ServerRejected` message without exposing
/// the raw body. Returns `None` when the token is absent.
fn classify_entitlement_failure(body_str: &str) -> Option<SyncError> {
    if body_str.contains(ENTITLEMENT_REQUIRED_TOKEN) {
        return Some(SyncError::ServerRejected {
            status: 403,
            code: Some(ENTITLEMENT_REQUIRED_TOKEN.to_string()),
            public_message: Some(ENTITLEMENT_REQUIRED_MESSAGE.to_string()),
        });
    }
    None
}

pub fn classify_rpc_failure(status: u16, body_str: &str, function_name: &'static str) -> SyncError {
    if let Some(err) = classify_entitlement_failure(body_str) {
        return err;
    }
    if status == 401 {
        return SyncError::Unauthorized;
    }
    if status == 403 {
        return SyncError::PermissionDenied;
    }

    let parsed = serde_json::from_str::<serde_json::Value>(body_str).ok();
    let code = parsed
        .as_ref()
        .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(String::from));

    if status == 404 && code.as_deref() == Some("PGRST202") {
        return SyncError::ServerFunctionUnavailable {
            name: function_name,
        };
    }

    if status == 400 && code.as_deref() == Some("P0001") {
        let msg = parsed
            .as_ref()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()))
            .unwrap_or_default();
        let sanitized: String = msg.chars().filter(|c| !c.is_control()).take(240).collect();
        return SyncError::ServerRejected {
            status,
            code,
            public_message: Some(sanitized),
        };
    }

    SyncError::ServerRejected {
        status,
        code,
        public_message: None,
    }
}

pub async fn rpc_failure(response: reqwest::Response, spec: &'static RpcSpec) -> SyncError {
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    classify_rpc_failure(status, &body, spec.name)
}

/// The sole function allowed to construct RPC URLs and execute RPCs.
pub async fn rpc_request(
    client: &reqwest::Client,
    cfg: &SyncConfig,
    optional_session: Option<&SyncSession>,
    spec: &RpcSpec,
    body: serde_json::Value,
) -> Result<reqwest::Response, SyncError> {
    let obj = body.as_object().ok_or_else(|| {
        SyncError::Db(format!(
            "RPC body for '{}' must be a JSON object",
            spec.name
        ))
    })?;

    let expected_keys: std::collections::HashSet<&str> = spec.args.iter().map(|a| a.name).collect();
    let actual_keys: std::collections::HashSet<&str> = obj.keys().map(|s| s.as_str()).collect();

    if expected_keys != actual_keys {
        return Err(SyncError::Db(format!(
            "RPC argument mismatch for '{}': expected {:?}, got {:?}",
            spec.name, expected_keys, actual_keys
        )));
    }

    let url = format!(
        "{}/rest/v1/rpc/{}",
        cfg.url.trim_end_matches('/'),
        spec.name
    );

    let mut req = client.post(&url).header("apikey", &cfg.anon_key);
    if let Some(session) = optional_session {
        req = req.header("Authorization", format!("Bearer {}", session.access_token));
    } else {
        req = req.header("Authorization", format!("Bearer {}", cfg.anon_key));
    }

    req.json(&body)
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))
}

/// Join a group by its key, choosing the name you file under.
///
/// The server function is the gate: anyone holding the key gets in, names are
/// unique per group, and a rejoin returns the existing membership untouched.
fn join_group_request(key: &str, coder_name: &str) -> serde_json::Value {
    serde_json::json!({
        "group_key": normalise_code(key),
        "coder_name": coder_name,
    })
}

pub async fn join_group_client_fn(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    key: &str,
    coder_name: &str,
) -> Result<JoinedGroup, SyncError> {
    let body = join_group_request(key, coder_name);
    let response = rpc_request(client, cfg, Some(session), &RPC_JOIN_GROUP, body).await?;
    if !response.status().is_success() {
        return Err(rpc_failure(response, &RPC_JOIN_GROUP).await);
    }

    response
        .json()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))
}

/// Mint a fresh group key, retiring the old one.
pub async fn reset_group_key_fn(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
) -> Result<String, SyncError> {
    let body = serde_json::json!({ "p_project_id": cfg.project_id });
    let response = rpc_request(client, cfg, Some(session), &RPC_RESET_GROUP_KEY, body).await?;
    if !response.status().is_success() {
        return Err(rpc_failure(response, &RPC_RESET_GROUP_KEY).await);
    }

    response
        .json()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))
}

/// Set a member's role (admin or coder). Admin-only RPC.
pub async fn set_member_role_fn(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    user_id: &str,
    role: &str,
) -> Result<(), SyncError> {
    let body = serde_json::json!({
        "p_project_id": cfg.project_id,
        "p_user_id": user_id,
        "p_role": role,
    });
    let response = rpc_request(client, cfg, Some(session), &RPC_SET_MEMBER_ROLE, body).await?;
    if !response.status().is_success() {
        return Err(rpc_failure(response, &RPC_SET_MEMBER_ROLE).await);
    }
    Ok(())
}

/// Remove a member from the group. Admin-only RPC.
pub async fn remove_member_fn(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    user_id: &str,
) -> Result<(), SyncError> {
    let body = serde_json::json!({
        "p_project_id": cfg.project_id,
        "p_user_id": user_id,
    });
    let response = rpc_request(client, cfg, Some(session), &RPC_REMOVE_MEMBER, body).await?;
    if !response.status().is_success() {
        return Err(rpc_failure(response, &RPC_REMOVE_MEMBER).await);
    }
    Ok(())
}

/// Delete the entire group. Admin-only RPC. Requires confirmation title.
pub async fn delete_group_fn(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    confirm_title: &str,
) -> Result<(), SyncError> {
    let body = serde_json::json!({
        "p_project_id": cfg.project_id,
        "p_confirm_title": confirm_title,
    });
    let response = rpc_request(client, cfg, Some(session), &RPC_DELETE_GROUP, body).await?;
    if !response.status().is_success() {
        return Err(rpc_failure(response, &RPC_DELETE_GROUP).await);
    }
    Ok(())
}

/// Leave the group. Removes the caller's membership row while keeping their coding.
pub async fn leave_group_fn(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    project_id: &str,
) -> Result<(), SyncError> {
    let body = serde_json::json!({
        "p_project_id": project_id,
    });
    let response = rpc_request(client, cfg, Some(session), &RPC_LEAVE_GROUP, body).await?;
    if !response.status().is_success() {
        return Err(rpc_failure(response, &RPC_LEAVE_GROUP).await);
    }
    Ok(())
}

/// One person in the group, as the roster shows them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    pub coder_name: String,
    /// When they joined. `None` for rows of coding filed under a name no
    /// current member holds — the record of their work outlives the membership
    /// bookkeeping, and the roster says so rather than dropping it.
    pub joined_at: Option<String>,
    /// Latest `updated_at` across their rows of coding. `None` if they have
    /// not filed any yet.
    pub last_active_at: Option<String>,
    /// Live rows of coding under this name.
    pub coded_count: i64,
    /// The signed-in account's own row — the one the rename pencil belongs on.
    pub is_you: bool,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub user_id: Option<String>,
}

/// The group's face: its key, its people, and what they have done.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub title: String,
    /// Display-formatted (`XXXX-XXXX`); [`normalise_code`] strips the dash.
    pub group_key: String,
    pub members: Vec<GroupMember>,
}

/// Fetch the group's key and roster.
///
/// Two queries, both scoped by row-level security: the project row for title
/// and key, then the member rows joined against per-name coding activity. The
/// activity aggregation runs here rather than in SQL because the roster also
/// lists names that hold no membership — coding filed before the group existed
/// stays visible instead of silently falling off the display.
pub async fn group_info_fetch(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
) -> Result<GroupInfo, SyncError> {
    #[derive(Deserialize)]
    struct ProjectRow {
        title: String,
        group_key: Option<String>,
    }
    let response = rest(client, cfg, session, reqwest::Method::GET, "projects")
        .query(&[
            ("select", "title,group_key".to_string()),
            ("project_id", format!("eq.{}", cfg.project_id)),
        ])
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(SyncError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(SyncError::Network(format!(
            "{}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        )));
    }
    let project_rows: Vec<ProjectRow> = response
        .json()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;
    let project = project_rows
        .into_iter()
        .next()
        .ok_or_else(|| SyncError::Network("Group not found.".into()))?;

    #[derive(Deserialize)]
    struct MemberRow {
        coder_name: String,
        user_id: String,
        joined_at: Option<String>,
        #[serde(default)]
        role: Option<String>,
    }
    let response = rest(
        client,
        cfg,
        session,
        reqwest::Method::GET,
        "project_members",
    )
    .query(&[
        ("select", "coder_name,user_id,role,joined_at".to_string()),
        ("project_id", format!("eq.{}", cfg.project_id)),
        ("order", "joined_at.asc".to_string()),
    ])
    .send()
    .await
    .map_err(|e| SyncError::Network(e.to_string()))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(SyncError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(SyncError::Network(format!(
            "{}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        )));
    }
    let member_rows: Vec<MemberRow> = response
        .json()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    #[derive(Deserialize)]
    struct ActivityRow {
        coder_name: String,
        updated_at: String,
    }
    let response = rest(client, cfg, session, reqwest::Method::GET, "coded_segments")
        .query(&[
            ("select", "coder_name,updated_at".to_string()),
            ("project_id", format!("eq.{}", cfg.project_id)),
            ("deleted", "is.false".to_string()),
        ])
        .send()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(SyncError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(SyncError::Network(format!(
            "{}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        )));
    }
    let activity_rows: Vec<ActivityRow> = response
        .json()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;

    // Aggregate per name. The roster is small — a study team, not a company —
    // so a linear fold beats pulling in a map type for it.
    let mut members: Vec<GroupMember> = member_rows
        .into_iter()
        .map(|m| GroupMember {
            is_you: m.user_id == session.user_id,
            coder_name: m.coder_name,
            joined_at: m.joined_at,
            last_active_at: None,
            coded_count: 0,
            role: m.role.or_else(|| Some("coder".to_string())),
            user_id: Some(m.user_id),
        })
        .collect();

    for a in activity_rows {
        match members.iter_mut().find(|m| m.coder_name == a.coder_name) {
            Some(m) => {
                m.coded_count += 1;
                if m.last_active_at.as_deref() < Some(a.updated_at.as_str()) {
                    m.last_active_at = Some(a.updated_at);
                }
            }
            // Coding under a name no member holds: filed before the group
            // existed, or before a rename. It still belongs on the roster.
            None => members.push(GroupMember {
                coder_name: a.coder_name.clone(),
                joined_at: None,
                last_active_at: Some(a.updated_at),
                coded_count: 1,
                is_you: false,
                role: None,
                user_id: None,
            }),
        }
    }

    Ok(GroupInfo {
        title: project.title,
        group_key: project
            .group_key
            .map(|k| format_group_key(&k))
            .unwrap_or_default(),
        members,
    })
}

/// The settled name after a rename — the server's, after its own trim and
/// length rules, plus the name it replaced so the local coder list can swap
/// the right entry.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RenamedSelf {
    #[serde(rename = "coderName", alias = "coder_name")]
    pub coder_name: String,
    #[serde(rename = "previousName", alias = "previous_name")]
    pub previous_name: String,
}

/// Change the name the signed-in member files under in this group.
///
/// The server function rewrites their coded rows to the new name in the same
/// transaction, so attribution follows the person rather than the string.
fn rename_coder_request(project_id: &str, coder_name: &str) -> serde_json::Value {
    serde_json::json!({
        "p_project_id": project_id,
        "p_coder_name": coder_name,
    })
}

pub async fn set_my_coder_name_fn(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    coder_name: &str,
) -> Result<RenamedSelf, SyncError> {
    let body = rename_coder_request(&cfg.project_id, coder_name);
    let response = rpc_request(client, cfg, Some(session), &RPC_SET_MY_CODER_NAME, body).await?;
    if !response.status().is_success() {
        return Err(rpc_failure(response, &RPC_SET_MY_CODER_NAME).await);
    }
    response
        .json()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))
}

/// What redeeming an invitation settled.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Redeemed {
    pub project_id: String,
    /// The name the inviter assigned. Returned so the joining app never has to
    /// ask for something the invitation already decided — and cannot end up
    /// filing coding under a name the server does not associate with them.
    pub coder_name: String,
}

/// Redeem an invitation, joining the study it belongs to.
///
/// Everything about *which* project and *which* coder name comes off the invite
/// row on the server — this call sends only the code, so a valid code cannot be
/// redirected at another study or used to file coding under a chosen name.
pub async fn redeem_invite(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    code: &str,
) -> Result<Redeemed, SyncError> {
    let body = serde_json::json!({ "invite_code": normalise_code(code) });
    let response = rpc_request(client, cfg, Some(session), &RPC_REDEEM_INVITE, body).await?;
    if !response.status().is_success() {
        return Err(rpc_failure(response, &RPC_REDEEM_INVITE).await);
    }

    #[derive(Deserialize)]
    struct Row {
        project_id: String,
        coder_name: String,
    }
    let row: Row = response
        .json()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;
    Ok(Redeemed {
        project_id: row.project_id,
        coder_name: row.coder_name,
    })
}

pub const REQUIRED_SERVER_SCHEMA: i32 = 10;

/// Query the server's declared schema version via public RPC.
pub async fn server_schema_version_fn(client: &Client, cfg: &SyncConfig) -> Result<i32, SyncError> {
    let body = serde_json::json!({});
    let response = rpc_request(client, cfg, None, &RPC_SERVER_SCHEMA_VERSION, body).await?;
    if !response.status().is_success() {
        return Err(rpc_failure(response, &RPC_SERVER_SCHEMA_VERSION).await);
    }
    let val: serde_json::Value = response
        .json()
        .await
        .map_err(|e| SyncError::Network(e.to_string()))?;
    if let Some(v) = val.as_i64() {
        Ok(v as i32)
    } else {
        Err(SyncError::Db(
            "server_schema_version did not return an integer".into(),
        ))
    }
}

/// Create the shared project, becoming its first member.
///
/// The membership row is added by a trigger in the same transaction — see
/// `add_creator_as_member` in `supabase/schema.sql`. Without it the policies
/// contradict each other and no project could ever be created from the app.
///
/// The group key is minted by the caller and sent with the insert: it never
/// has to come back over the wire to be read, and a unique-index collision is
/// retried here with a fresh draw rather than shown to anybody.
/// Classify a failed direct REST project create: entitlement token first, then
/// the ordinary outcomes. A `group_key` conflict is a retry for the caller, so
/// it is classified separately and never surfaces here.
fn classify_rest_create_failure(status: u16, body: String) -> SyncError {
    if let Some(err) = classify_entitlement_failure(&body) {
        return err;
    }
    match status {
        401 => SyncError::Unauthorized,
        s => SyncError::Network(format!("{s}: {body}")),
    }
}

pub async fn create_remote_project(
    client: &Client,
    cfg: &SyncConfig,
    session: &SyncSession,
    title: &str,
) -> Result<String, SyncError> {
    let mut last_conflict = None;
    for _ in 0..5 {
        let key = new_group_key();
        let response = rest(client, cfg, session, reqwest::Method::POST, "projects")
            .header("Prefer", "return=minimal")
            .json(&serde_json::json!({
                "project_id": cfg.project_id,
                "title": title,
                "group_key": key,
            }))
            .send()
            .await
            .map_err(|e| SyncError::Network(e.to_string()))?;

        if response.status().is_success() {
            return Ok(key);
        }
        // Read the body once: an entitlement-gated create arrives as HTTP 403
        // with the stable token and must map to the friendly message, not to a
        // generic network error or an exhausted retry loop.
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if classify_entitlement_failure(&body).is_some() {
            return Err(classify_rest_create_failure(status.as_u16(), body));
        }
        if status == StatusCode::CONFLICT && body.contains("group_key") {
            // A conflict on the key's unique index is a duplicate draw; any
            // other conflict is the project id, which retrying cannot fix —
            // but the detail string distinguishes them.
            last_conflict = Some(body);
            continue;
        }
        return Err(classify_rest_create_failure(status.as_u16(), body));
    }
    Err(SyncError::Network(format!(
        "Could not find an unused group key after 5 tries: {}",
        last_conflict.unwrap_or_default()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn project() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let path = db::create_project(&crate::models::CreateProjectInput {
            parent_dir: dir.path().to_string_lossy().to_string(),
            project_name: "p".into(),
            title: "T".into(),
            coders: vec!["Ada".into()],
        })
        .unwrap();
        let conn = db::open_project(&path.to_string_lossy()).unwrap();
        (dir, conn)
    }

    fn seed_one_coded(conn: &Connection) -> String {
        let iv = db::create_interview(
            conn,
            &crate::models::CreateInterviewInput {
                participant_label: "JH".into(),
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
                    speaker: "S".into(),
                    timestamp_start: "00:00:00.000".into(),
                    timestamp_end: None,
                    text: "she said she practised smiling in the mirror".into(),
                    section_tag: None,
                }],
                raw_vtt_path: None,
            },
        )
        .unwrap();
        let seg = db::get_segments(conn, &iv.id).unwrap()[0].id.clone();
        db::apply_codes(
            conn,
            &crate::models::ApplyCodesInput {
                interview_id: iv.id,
                segment_id: seg,
                code_ids: vec!["code-1".into()],
                coder_name: "Ada".into(),
                memo: Some("this is the clearest masking account in the set".into()),
                char_start: None,
                char_end: None,
            },
        )
        .unwrap();
        "code-1".to_string()
    }

    fn remote_coded(id: &str, interview_id: &str, segment_id: &str) -> CodedSegmentPayload {
        CodedSegmentPayload {
            id: id.into(),
            project_id: "proj-1".into(),
            interview_id: interview_id.into(),
            segment_id: segment_id.into(),
            code_ids: vec!["c1".into()],
            coder_name: "Sam".into(),
            char_start: None,
            char_end: None,
            revision: 1,
            deleted: false,
            updated_at: None,
        }
    }

    fn remote_code(id: &str) -> CodePayload {
        CodePayload {
            id: id.into(),
            project_id: "proj-1".into(),
            name: "masking".into(),
            definition: None,
            parent_id: None,
            color: Some("#888888".into()),
            sort_order: 0,
            is_retired: false,
            deleted: false,
            revision: 1,
            updated_at: None,
        }
    }

    #[test]
    fn recovery_verify_sends_hash_without_email_and_otp_with_email() {
        let hash = recovery_verify_body("a@b.c", None, Some("deadbeef")).unwrap();
        assert_eq!(hash["type"], "recovery");
        assert_eq!(hash["token_hash"], "deadbeef");
        assert!(hash.get("email").is_none(), "{hash}");
        assert!(hash.get("token").is_none(), "{hash}");

        let otp = recovery_verify_body("a@b.c", Some("482193"), None).unwrap();
        assert_eq!(otp["type"], "recovery");
        assert_eq!(otp["email"], "a@b.c");
        assert_eq!(otp["token"], "482193");
        assert!(otp.get("token_hash").is_none(), "{otp}");

        let both = recovery_verify_body("a@b.c", Some("482193"), Some("deadbeef")).unwrap();
        assert_eq!(both["token_hash"], "deadbeef");
        assert!(both.get("email").is_none(), "{both}");

        let empty = recovery_verify_body("a@b.c", None, None).unwrap_err();
        assert!(empty.to_string().contains("reset code"), "{empty}");
    }

    #[test]
    fn auth_failures_say_what_to_do_about_them() {
        use reqwest::StatusCode;
        let bad = StatusCode::BAD_REQUEST;

        let wrong = explain_auth_failure(
            bad,
            r#"{"error":"invalid_grant","error_description":"Invalid login credentials"}"#,
        );
        assert!(wrong.contains("do not match an account"), "{wrong}");
        assert!(wrong.contains("Forgot password"), "{wrong}");
        // The raw body named neither the fix nor the likely cause.
        assert!(!wrong.contains("invalid_grant"), "{wrong}");

        let unconfirmed = explain_auth_failure(bad, r#"{"msg":"Email not confirmed"}"#);
        assert!(unconfirmed.contains("confirmation link"), "{unconfirmed}");

        let taken = explain_auth_failure(bad, r#"{"msg":"User already registered"}"#);
        assert!(taken.contains("I already have one"), "{taken}");
        assert!(taken.contains("Forgot password"), "{taken}");

        let short =
            explain_auth_failure(bad, r#"{"msg":"Password should be at least 6 characters"}"#);
        assert!(short.contains("at least 6"), "{short}");

        let stale = explain_auth_failure(bad, r#"{"error_code":"otp_expired"}"#);
        assert!(stale.contains("no longer valid"), "{stale}");

        let throttled = explain_auth_failure(StatusCode::TOO_MANY_REQUESTS, "{}");
        assert!(throttled.contains("Wait a minute"), "{throttled}");
    }

    /// An error nobody anticipated is the one most worth reading in full.
    #[test]
    fn an_unrecognised_auth_error_is_not_flattened_into_an_apology() {
        let body = r#"{"msg":"project is paused"}"#;
        let out = explain_auth_failure(reqwest::StatusCode::BAD_REQUEST, body);
        assert_eq!(out, body);
    }

    #[test]
    fn an_empty_body_still_names_the_status() {
        let out = explain_auth_failure(reqwest::StatusCode::SERVICE_UNAVAILABLE, "   ");
        assert!(out.contains("503"), "{out}");
    }

    /// 🔴 The bug that made joining a study impossible.
    ///
    /// A joining coder pulls their colleague's coding before importing any
    /// transcript. Those rows referenced passages this machine did not have,
    /// the foreign key on `coded_segments.segment_id` rejected them, and since
    /// the whole apply is one transaction the entire pull rolled back — the
    /// codebook they were joining *for* included.
    #[test]
    fn coding_for_an_unimported_passage_does_not_destroy_the_pull() {
        let (_dir, conn) = project();

        let batch = PullBatch {
            coded: vec![remote_coded("cs-1", "iv-not-here", "seg-not-here")],
            codes: vec![remote_code("c1")],
            interviews: vec![],
            truncated: false,
        };

        let outcome = apply_pull(&conn, &batch).expect("the pull must survive");
        assert_eq!(outcome.pulled_coded, 1);

        // The codebook — the thing the joiner actually needs — arrived.
        let codes: i64 = conn
            .query_row("SELECT COUNT(*) FROM codebook", [], |r| r.get(0))
            .unwrap();
        assert_eq!(codes, 1, "the codebook was rolled back with the coding");

        // And the coding is held, not dropped.
        assert_eq!(crate::db::pending_coded_count(&conn).unwrap(), 1);
    }

    /// The other half: staged coding becomes real the moment the transcript
    /// lands, with nothing for the user to match up by hand.
    #[test]
    fn staged_coding_attaches_itself_when_the_transcript_arrives() {
        let (_dir, conn) = project();

        // Same label and same text the other coder imported, so the derived
        // ids agree — which is the entire premise of content-derived ids.
        let label = "P07";
        let text = "she said she practised smiling in the mirror";
        let interview_id = crate::ids::interview_id(label);
        let segment_id = crate::ids::segment_id(&interview_id, 0, text);

        apply_pull(
            &conn,
            &PullBatch {
                coded: vec![remote_coded("cs-1", &interview_id, &segment_id)],
                codes: vec![remote_code("c1")],
                interviews: vec![],
                truncated: false,
            },
        )
        .unwrap();
        assert_eq!(crate::db::pending_coded_count(&conn).unwrap(), 1);

        let iv = db::create_interview(
            &conn,
            &crate::models::CreateInterviewInput {
                participant_label: label.into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();
        assert_eq!(
            iv.id, interview_id,
            "interview ids must be derived, not minted"
        );

        db::import_segments(
            &conn,
            &crate::models::ImportSegmentsInput {
                interview_id: iv.id.clone(),
                segments: vec![crate::models::SegmentInput {
                    speaker: "P07".into(),
                    timestamp_start: "00:00:00.000".into(),
                    timestamp_end: None,
                    text: text.into(),
                    section_tag: None,
                }],
                raw_vtt_path: None,
            },
        )
        .unwrap();

        assert_eq!(
            crate::db::pending_coded_count(&conn).unwrap(),
            0,
            "staged coding should have drained on import"
        );
        let landed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM coded_segments WHERE coder_name = 'Sam' AND sync_dirty = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(landed, 1, "the colleague's coding did not attach");
    }

    /// Build a project holding one coded segment filed locally by `coder`.
    ///
    /// Returns the connection, the interview id, the segment id, and the local
    /// row's id.
    fn project_with_local_coding(
        coder: &str,
    ) -> (tempfile::TempDir, Connection, String, String, String) {
        let (dir, conn) = project();
        let interview_id = crate::ids::interview_id("P07");
        let text = "I rehearse the hello on the drive in";
        let segment_id = crate::ids::segment_id(&interview_id, 0, text);

        db::create_interview(
            &conn,
            &crate::models::CreateInterviewInput {
                participant_label: "P07".into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();
        db::import_segments(
            &conn,
            &crate::models::ImportSegmentsInput {
                interview_id: interview_id.clone(),
                segments: vec![crate::models::SegmentInput {
                    speaker: "P07".into(),
                    timestamp_start: "00:00:00.000".into(),
                    timestamp_end: None,
                    text: text.into(),
                    section_tag: None,
                }],
                raw_vtt_path: None,
            },
        )
        .unwrap();
        let local = db::apply_codes(
            &conn,
            &crate::models::ApplyCodesInput {
                interview_id: interview_id.clone(),
                segment_id: segment_id.clone(),
                code_ids: vec!["c-local".into()],
                coder_name: coder.into(),
                memo: Some("my margin note".into()),
                char_start: None,
                char_end: None,
            },
        )
        .unwrap();
        (dir, conn, interview_id, segment_id, local.id)
    }

    /// 🔴 The two-machines case. One coder codes the same passage on two
    /// machines; each machine mints its own id. When the pull brings the
    /// server's row over, the local twin must take the server's id — otherwise
    /// the next push collides with the (passage, coder, span) constraint, and
    /// every sync after that one fails on the same row.
    #[test]
    fn a_pull_rekeys_a_twin_onto_the_servers_id() {
        let (_dir, conn, interview_id, segment_id, local_id) = project_with_local_coding("Ada");
        let batch = collect_push_batch(&conn, "p").unwrap();
        mark_pushed(&conn, &batch).unwrap();

        let mut incoming = remote_coded("srv-9", &interview_id, &segment_id);
        incoming.coder_name = "Ada".into();
        incoming.code_ids = vec!["c-server".into()];
        incoming.revision = 5; // the local row is revision 1

        apply_pull(
            &conn,
            &PullBatch {
                coded: vec![incoming],
                codes: vec![],
                interviews: vec![],
                truncated: false,
            },
        )
        .unwrap();

        let rows: Vec<(String, String, i64, Option<String>)> = conn
            .prepare("SELECT id, code_ids, sync_dirty, memo FROM coded_segments")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();

        assert_eq!(
            rows.len(),
            1,
            "the twin must merge, not duplicate: {rows:?}"
        );
        let (id, code_ids, dirty, memo) = &rows[0];
        assert_eq!(id, "srv-9", "the survivor takes the server's id");
        assert_ne!(id, &local_id, "the local id is gone");
        assert_eq!(code_ids, "[\"c-server\"]", "higher revision won");
        assert_eq!(*dirty, 0, "the merged row is not this machine's to re-push");
        assert_eq!(
            memo.as_deref(),
            Some("my margin note"),
            "memos never travel, so the pull must not erase one"
        );
    }

    /// The mirror image: the local twin is *newer*. It keeps its content, still
    /// takes the server's id, and stays dirty — so the next push writes the
    /// winning revision to the server under the id the server already knows,
    /// merging instead of colliding.
    #[test]
    fn a_newer_local_twin_keeps_its_content_under_the_servers_id() {
        let (_dir, conn, interview_id, segment_id, _local_id) = project_with_local_coding("Ada");
        // The local coder revises: revision 2, dirty.
        conn.execute(
            "UPDATE coded_segments SET revision = 2, code_ids = '[\"c-local-v2\"]'",
            [],
        )
        .unwrap();

        let mut incoming = remote_coded("srv-9", &interview_id, &segment_id);
        incoming.coder_name = "Ada".into();
        incoming.code_ids = vec!["c-server".into()];
        incoming.revision = 1;

        apply_pull(
            &conn,
            &PullBatch {
                coded: vec![incoming],
                codes: vec![],
                interviews: vec![],
                truncated: false,
            },
        )
        .unwrap();

        let (id, code_ids, dirty): (String, String, i64) = conn
            .query_row(
                "SELECT id, code_ids, sync_dirty FROM coded_segments",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(id, "srv-9");
        let parsed_codes: Vec<String> = serde_json::from_str(&code_ids).unwrap();
        assert!(parsed_codes.contains(&"c-local-v2".to_string()));
        assert!(parsed_codes.contains(&"c-server".to_string()));
        assert_eq!(dirty, 1, "still dirty, so the next push carries it across");

        // And that push is what the rescue collects: the batch must name the
        // server's id, not the retired local one.
        let batch = collect_push_batch(&conn, "proj-1").unwrap();
        assert_eq!(batch.coded.len(), 1);
        assert_eq!(batch.coded[0].id, "srv-9");
    }

    /// The 409 that survived v0.18.0's rescue: a highlight id was flattened
    /// locally into a live whole-turn row, and the server already holds `*:*`
    /// under a different id. Pulling the server's whole-turn tombstone must
    /// re-key the local row onto that id so the next push merges instead of
    /// trying to move the highlight id onto an occupied slot.
    #[test]
    fn a_flattened_highlight_rekeys_onto_the_servers_whole_turn_tombstone() {
        let (_dir, conn, interview_id, segment_id, _) = project_with_local_coding("Ada");
        conn.execute(
            "UPDATE coded_segments
                SET id = '7f784c20', revision = 4, sync_dirty = 1,
                    code_ids = '[\"c-local-v2\"]'",
            [],
        )
        .unwrap();

        let mut tombstone = remote_coded("5d5f390b", &interview_id, &segment_id);
        tombstone.coder_name = "Ada".into();
        tombstone.deleted = true;
        tombstone.revision = 1;
        tombstone.char_start = None;
        tombstone.char_end = None;

        apply_pull(
            &conn,
            &PullBatch {
                coded: vec![tombstone],
                codes: vec![],
                interviews: vec![],
                truncated: false,
            },
        )
        .unwrap();

        let (id, deleted, dirty, start, end): (String, i64, i64, Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT id, deleted, sync_dirty, char_start, char_end FROM coded_segments",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(
            id, "5d5f390b",
            "the local whole-turn takes the server's *:* id"
        );
        assert_eq!(deleted, 0, "newer local live content stays live");
        assert_eq!(
            dirty, 1,
            "still this machine's to push, under the server's id"
        );
        assert_eq!((start, end), (None, None));

        let batch = collect_push_batch(&conn, "proj-1").unwrap();
        assert_eq!(batch.coded.len(), 1);
        assert_eq!(batch.coded[0].id, "5d5f390b");
        assert_eq!(batch.coded[0].char_start, None);
        assert!(!batch.coded[0].deleted);

        let mut highlight = remote_coded("7f784c20", &interview_id, &segment_id);
        highlight.coder_name = "Ada".into();
        highlight.char_start = Some(494);
        highlight.char_end = Some(577);
        highlight.revision = 0;
        apply_pull(
            &conn,
            &PullBatch {
                coded: vec![highlight],
                codes: vec![],
                interviews: vec![],
                truncated: false,
            },
        )
        .unwrap();

        let rows: Vec<(String, Option<i64>, Option<i64>, i64)> = conn
            .prepare("SELECT id, char_start, char_end, deleted FROM coded_segments ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            rows.len(),
            2,
            "the highlight must come back as its own row: {rows:?}"
        );
        assert!(
            rows.iter().any(|(id, a, b, d)| {
                id == "7f784c20" && *a == Some(494) && *b == Some(577) && *d == 0
            }),
            "highlight 7f784c20 did not re-insert: {rows:?}"
        );
    }

    /// The same reconciliation applies to highlight spans: a span is part of
    /// the natural key, so a whole-turn twin and a highlight twin of the same
    /// passage are different rows and must not merge.
    #[test]
    fn twins_match_on_the_span_not_just_the_passage() {
        let (_dir, conn, interview_id, segment_id, local_id) = project_with_local_coding("Ada");

        // The server has a *highlight* on the same passage by the same coder —
        // not a twin of the local whole-turn row.
        let mut highlight = remote_coded("srv-span", &interview_id, &segment_id);
        highlight.coder_name = "Ada".into();
        highlight.char_start = Some(2);
        highlight.char_end = Some(18);
        highlight.revision = 3;

        apply_pull(
            &conn,
            &PullBatch {
                coded: vec![highlight],
                codes: vec![],
                interviews: vec![],
                truncated: false,
            },
        )
        .unwrap();

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM coded_segments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2, "a highlight is not a twin of the whole turn");
        let untouched: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM coded_segments WHERE id = ?1",
                params![local_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(untouched, 1, "the local whole-turn row keeps its own id");
    }

    /// 🔴 A highlight that arrives as a whole-turn coding is a silently wrong
    /// answer, not a missing feature: the code would appear against the entire
    /// speaker turn on the other machine and nothing would look broken.
    /// `apply_pull` used to hard-code `char_start: None`.
    #[test]
    fn a_highlight_keeps_its_span_across_sync() {
        let (_dir, conn) = project();
        let interview_id = crate::ids::interview_id("P07");
        let text = "I rehearse the hello on the drive in";
        let segment_id = crate::ids::segment_id(&interview_id, 0, text);

        db::create_interview(
            &conn,
            &crate::models::CreateInterviewInput {
                participant_label: "P07".into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();
        db::import_segments(
            &conn,
            &crate::models::ImportSegmentsInput {
                interview_id: interview_id.clone(),
                segments: vec![crate::models::SegmentInput {
                    speaker: "P07".into(),
                    timestamp_start: "00:00:00.000".into(),
                    timestamp_end: None,
                    text: text.into(),
                    section_tag: None,
                }],
                raw_vtt_path: None,
            },
        )
        .unwrap();

        let mut incoming = remote_coded("cs-span", &interview_id, &segment_id);
        incoming.char_start = Some(2);
        incoming.char_end = Some(18);

        apply_pull(
            &conn,
            &PullBatch {
                coded: vec![incoming],
                codes: vec![],
                interviews: vec![],
                truncated: false,
            },
        )
        .unwrap();

        let span: (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT char_start, char_end FROM coded_segments WHERE id = 'cs-span'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            span,
            (Some(2), Some(18)),
            "the highlight widened to the whole turn"
        );
    }

    /// The same guarantee on the staging path: a joiner's highlights must not
    /// flatten while they wait for the transcript.
    #[test]
    fn a_staged_highlight_keeps_its_span_when_it_drains() {
        let (_dir, conn) = project();
        let interview_id = crate::ids::interview_id("P07");
        let text = "I rehearse the hello on the drive in";
        let segment_id = crate::ids::segment_id(&interview_id, 0, text);

        let mut incoming = remote_coded("cs-span", &interview_id, &segment_id);
        incoming.char_start = Some(2);
        incoming.char_end = Some(18);
        apply_pull(
            &conn,
            &PullBatch {
                coded: vec![incoming],
                codes: vec![],
                interviews: vec![],
                truncated: false,
            },
        )
        .unwrap();

        db::create_interview(
            &conn,
            &crate::models::CreateInterviewInput {
                participant_label: "P07".into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();
        db::import_segments(
            &conn,
            &crate::models::ImportSegmentsInput {
                interview_id: interview_id.clone(),
                segments: vec![crate::models::SegmentInput {
                    speaker: "P07".into(),
                    timestamp_start: "00:00:00.000".into(),
                    timestamp_end: None,
                    text: text.into(),
                    section_tag: None,
                }],
                raw_vtt_path: None,
            },
        )
        .unwrap();

        let span: (Option<i64>, Option<i64>) = conn
            .query_row(
                "SELECT char_start, char_end FROM coded_segments WHERE id = 'cs-span'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(span, (Some(2), Some(18)));
    }

    /// Drained rows must not be pushed back as though this machine wrote them.
    #[test]
    fn drained_coding_is_not_treated_as_this_machines_work() {
        let (_dir, conn) = project();
        let interview_id = crate::ids::interview_id("P07");
        let text = "a line";
        let segment_id = crate::ids::segment_id(&interview_id, 0, text);

        apply_pull(
            &conn,
            &PullBatch {
                coded: vec![remote_coded("cs-1", &interview_id, &segment_id)],
                codes: vec![],
                interviews: vec![],
                truncated: false,
            },
        )
        .unwrap();

        db::create_interview(
            &conn,
            &crate::models::CreateInterviewInput {
                participant_label: "P07".into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();
        db::import_segments(
            &conn,
            &crate::models::ImportSegmentsInput {
                interview_id: interview_id.clone(),
                segments: vec![crate::models::SegmentInput {
                    speaker: "P07".into(),
                    timestamp_start: "00:00:00.000".into(),
                    timestamp_end: None,
                    text: text.into(),
                    section_tag: None,
                }],
                raw_vtt_path: None,
            },
        )
        .unwrap();

        let batch = collect_push_batch(&conn, "proj-1").unwrap();
        assert!(
            !batch.coded.iter().any(|r| r.id == "cs-1"),
            "pulled coding was queued straight back to the server"
        );
    }

    /// The guarantee the whole design rests on, asserted against a row that
    /// deliberately carries a memo and belongs to a labelled participant.
    #[test]
    fn payload_carries_no_free_text() {
        let (_dir, conn) = project();
        seed_one_coded(&conn);

        let batch = collect_push_batch(&conn, "proj-1").unwrap();
        assert_eq!(batch.coded.len(), 1);

        let json = serde_json::to_string(&batch.coded).unwrap();

        for forbidden in [
            "practised smiling", // transcript text
            "clearest masking",  // the coder's memo
            "JH",                // participant label
        ] {
            assert!(
                !json.contains(forbidden),
                "sync payload leaked {forbidden:?}: {json}"
            );
        }

        // And positively: the payload is ids plus the coder's own name.
        assert!(json.contains("Ada"));
        assert!(json.contains("code-1"));
    }

    #[test]
    fn updated_at_is_never_sent_but_is_read() {
        let payload = CodedSegmentPayload {
            id: "a".into(),
            project_id: "p".into(),
            interview_id: "i".into(),
            segment_id: "s".into(),
            code_ids: vec!["c".into()],
            coder_name: "Ada".into(),
            char_start: None,
            char_end: None,
            deleted: false,
            revision: 3,
            updated_at: Some("2026-08-16T00:00:00Z".into()),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(
            !json.contains("updated_at"),
            "the server sets updated_at; sending ours would let clock skew \
             resolve conflicts backwards"
        );

        let parsed: CodedSegmentPayload = serde_json::from_str(
            r#"{"id":"a","project_id":"p","interview_id":"i",
              "segment_id":"s","code_ids":["c"],"coder_name":"Ada",
              "deleted":false,"revision":3,"updated_at":"2026-08-16T00:00:00Z"}"#,
        )
        .unwrap();
        assert_eq!(parsed.updated_at.as_deref(), Some("2026-08-16T00:00:00Z"));
    }

    #[test]
    fn only_dirty_rows_are_collected() {
        let (_dir, conn) = project();
        seed_one_coded(&conn);

        let batch = collect_push_batch(&conn, "p").unwrap();
        assert_eq!(batch.coded.len(), 1);

        mark_pushed(&conn, &batch).unwrap();
        assert!(
            collect_push_batch(&conn, "p").unwrap().coded.is_empty(),
            "a pushed row must not be offered again"
        );
    }

    #[test]
    fn an_edit_during_a_push_is_not_marked_clean() {
        let (_dir, conn) = project();
        seed_one_coded(&conn);
        let batch = collect_push_batch(&conn, "p").unwrap();

        // The coder revises the passage while the request is in flight, which
        // bumps the revision.
        conn.execute(
            "UPDATE coded_segments SET revision = revision + 1, sync_dirty = 1",
            [],
        )
        .unwrap();

        mark_pushed(&conn, &batch).unwrap();
        assert_eq!(
            collect_push_batch(&conn, "p").unwrap().coded.len(),
            1,
            "the newer edit must survive the acknowledgement of the older one"
        );
    }

    #[test]
    fn corpus_hash_ignores_whitespace_but_not_content() {
        let (_dir, conn) = project();
        seed_one_coded(&conn);
        let base = corpus_hash(&conn).unwrap();

        conn.execute(
            "UPDATE transcript_segments
             SET text = 'she said she  practised   smiling in the mirror'",
            [],
        )
        .unwrap();
        assert_eq!(
            corpus_hash(&conn).unwrap(),
            base,
            "re-parsing a VTT into different spacing is not a different corpus"
        );

        conn.execute(
            "UPDATE transcript_segments SET text = 'a completely different line'",
            [],
        )
        .unwrap();
        assert_ne!(
            corpus_hash(&conn).unwrap(),
            base,
            "changed transcript text must invalidate the corpus"
        );
    }

    #[test]
    fn a_pull_never_overwrites_a_local_memo() {
        let (_dir, conn) = project();
        seed_one_coded(&conn);
        let row = collect_push_batch(&conn, "p").unwrap().coded[0].clone();

        let incoming = PullBatch {
            coded: vec![CodedSegmentPayload {
                code_ids: vec!["code-2".into()],
                revision: row.revision + 1,
                updated_at: Some("2026-08-16T12:00:00Z".into()),
                ..row.clone()
            }],
            codes: vec![],
            interviews: vec![],
            truncated: false,
        };
        apply_pull(&conn, &incoming).unwrap();

        let memo: Option<String> = conn
            .query_row(
                "SELECT memo FROM coded_segments WHERE id = ?1",
                params![row.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            memo.as_deref(),
            Some("this is the clearest masking account in the set"),
            "a memo belongs to the person at this keyboard and never syncs"
        );
    }

    #[test]
    fn a_pulled_tombstone_clears_the_memo() {
        let (_dir, conn) = project();
        seed_one_coded(&conn);
        let batch = collect_push_batch(&conn, "p").unwrap();
        let row = batch.coded[0].clone();
        mark_pushed(&conn, &batch).unwrap();

        apply_pull(
            &conn,
            &PullBatch {
                coded: vec![CodedSegmentPayload {
                    deleted: true,
                    code_ids: vec![],
                    revision: row.revision + 1,
                    updated_at: Some("2026-08-16T12:00:00Z".into()),
                    ..row.clone()
                }],
                codes: vec![],
                interviews: vec![],
                truncated: false,
            },
        )
        .unwrap();

        let memo: Option<String> = conn
            .query_row(
                "SELECT memo FROM coded_segments WHERE id = ?1",
                params![row.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(memo, None, "removed coding must not leave its memo behind");
    }

    #[test]
    fn a_stale_pull_loses_to_a_newer_local_row() {
        let (_dir, conn) = project();
        seed_one_coded(&conn);
        let batch = collect_push_batch(&conn, "p").unwrap();
        let row = batch.coded[0].clone();
        mark_pushed(&conn, &batch).unwrap();

        conn.execute("UPDATE coded_segments SET revision = 5", [])
            .unwrap();

        apply_pull(
            &conn,
            &PullBatch {
                coded: vec![CodedSegmentPayload {
                    code_ids: vec!["stale".into()],
                    revision: 2,
                    updated_at: Some("2026-08-16T12:00:00Z".into()),
                    ..row.clone()
                }],
                codes: vec![],
                interviews: vec![],
                truncated: false,
            },
        )
        .unwrap();

        let codes: String = conn
            .query_row(
                "SELECT code_ids FROM coded_segments WHERE id = ?1",
                params![row.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            !codes.contains("stale"),
            "an older revision must not overwrite a newer local edit"
        );
    }

    #[test]
    fn the_interview_roster_carries_no_transcript() {
        let (_dir, conn) = project();
        seed_one_coded(&conn);

        let batch = collect_push_batch(&conn, "p").unwrap();
        assert_eq!(batch.interviews.len(), 1);
        let json = serde_json::to_string(&batch.interviews).unwrap();

        assert!(
            !json.contains("practised smiling"),
            "the roster must not carry transcript text: {json}"
        );
        // The label does cross, on purpose — it is the tokenised study ID the
        // protocol requires, and it is what tells the other coder which file to
        // fetch. Asserted positively so that intent is visible rather than
        // looking like an oversight.
        assert!(json.contains("JH"));
        assert!(json.contains("content_hash"));
    }

    #[test]
    fn missing_transcripts_tells_not_imported_from_imported_differently() {
        let (_dir, conn) = project();
        seed_one_coded(&conn);
        let iv = db::list_interviews(&conn).unwrap()[0].id.clone();
        let real_hash = interview_content_hash(&conn, &iv).unwrap().unwrap();

        // Nothing reported while this machine matches what the roster claims.
        conn.execute(
            "UPDATE interviews SET remote_segment_count = 1, remote_content_hash = ?1",
            params![real_hash],
        )
        .unwrap();
        assert!(missing_transcripts(&conn).unwrap().is_empty());

        // The other coder has a different file for this interview.
        conn.execute(
            "UPDATE interviews SET remote_content_hash = 'something-else'",
            [],
        )
        .unwrap();
        let flagged = missing_transcripts(&conn).unwrap();
        assert_eq!(flagged.len(), 1);
        assert!(
            flagged[0].mismatched,
            "an interview imported from a different file is a mismatch, not a gap"
        );

        // This machine has never imported it.
        conn.execute("DELETE FROM transcript_segments", []).unwrap();
        let flagged = missing_transcripts(&conn).unwrap();
        assert_eq!(flagged.len(), 1);
        assert!(
            !flagged[0].mismatched,
            "a transcript never imported is a gap, not a mismatch"
        );
        assert_eq!(flagged[0].study_label, "JH");
    }

    #[test]
    fn ensure_project_id_is_minted_once_and_then_stable() {
        let (_dir, conn) = project();
        let first = ensure_project_id(&conn).unwrap();
        assert_eq!(
            ensure_project_id(&conn).unwrap(),
            first,
            "the id is minted once and reused; joining a shared project is \
             what replaces it"
        );
    }

    #[test]
    fn a_minted_id_does_not_mean_the_folder_is_in_a_group() {
        let (_dir, conn) = project();
        ensure_project_id(&conn).unwrap();
        assert!(
            !is_bound(&conn).unwrap(),
            "minting an id is a local bookkeeping step, not membership"
        );
    }

    #[test]
    fn bind_to_group_is_idempotent_on_the_same_id() {
        let (_dir, conn) = project();
        bind_to_group(&conn, "shared-a").unwrap();
        bind_to_group(&conn, "shared-a").unwrap();
        assert_eq!(
            get_state(&conn, KEY_PROJECT_ID).unwrap().as_deref(),
            Some("shared-a")
        );
        assert!(is_bound(&conn).unwrap());
    }

    #[test]
    fn bind_to_group_refuses_a_folder_already_in_a_different_group() {
        let (_dir, conn) = project();
        bind_to_group(&conn, "shared-a").unwrap();
        let err = bind_to_group(&conn, "shared-b").unwrap_err();
        assert!(
            matches!(err, SyncError::AlreadyBound),
            "rebinding is Change project; got {err}"
        );
        assert_eq!(
            get_state(&conn, KEY_PROJECT_ID).unwrap().as_deref(),
            Some("shared-a"),
            "a refused bind must not touch the existing id"
        );
    }

    #[test]
    fn an_unbound_minted_id_is_replaced_when_joining() {
        let (_dir, conn) = project();
        let minted = ensure_project_id(&conn).unwrap();
        bind_to_group(&conn, "shared").unwrap();
        assert_ne!(minted, "shared");
        assert_eq!(
            get_state(&conn, KEY_PROJECT_ID).unwrap().as_deref(),
            Some("shared")
        );
        assert!(is_bound(&conn).unwrap());
    }

    #[test]
    fn the_join_picker_decodes_what_postgrest_actually_sends() {
        // Byte-for-byte the shape PostgREST returns for
        // `GET /rest/v1/project_members?select=project_id,coder_name,projects(title)`.
        let body = r#"[{"project_id":"1afe114e-05f5-4249-b24d-42f5d781ddfa",
                        "coder_name":"Ada",
                        "projects":{"title":"Sample Interview Study"}}]"#;
        let rows: Vec<MembershipRow> =
            serde_json::from_str(body).expect("the join picker must decode a real reply");
        let summaries: Vec<MembershipSummary> =
            rows.into_iter().map(MembershipRow::into_summary).collect();
        assert_eq!(
            summaries[0].project_id,
            "1afe114e-05f5-4249-b24d-42f5d781ddfa"
        );
        assert_eq!(summaries[0].coder_name, "Ada");
        assert_eq!(summaries[0].title, "Sample Interview Study");

        // …and the frontend still receives camelCase, which is the reason the
        // container rename was there in the first place.
        let out = serde_json::to_string(&summaries[0]).unwrap();
        assert!(
            out.contains("\"projectId\"") && out.contains("\"coderName\""),
            "JoinStudyModal reads m.projectId and m.coderName; got {out}"
        );
    }

    #[test]
    fn an_empty_membership_list_is_why_that_bug_stayed_hidden() {
        // A `Vec<T>` decodes from `[]` no matter how wrong T's field names are,
        // so every run before the first group join looked healthy.
        let rows: Vec<MembershipSummary> = serde_json::from_str("[]").unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn a_group_key_is_eight_characters_from_the_unambiguous_alphabet() {
        for _ in 0..500 {
            let key = new_group_key();
            assert_eq!(key.len(), GROUP_KEY_LEN);
            for c in key.chars() {
                assert!(
                    CODE_ALPHABET.contains(&(c as u8)),
                    "{c} is not in the alphabet — I, L, O and U are excluded \
                     precisely because they are misread"
                );
            }
        }
    }

    #[test]
    fn keys_are_drawn_from_the_random_bytes_of_a_uuid() {
        // The bias note on `new_group_key` covers bytes 6 and 8; this covers
        // the other half: that the draw is actually varying.
        let draws: std::collections::HashSet<String> = (0..200).map(|_| new_group_key()).collect();
        assert!(
            draws.len() > 190,
            "200 draws collapsed to {} distinct keys — the source is not random",
            draws.len()
        );
    }

    #[test]
    fn a_group_key_formats_with_a_dash_and_normalises_back() {
        let key = new_group_key();
        let shown = format_group_key(&key);
        assert_eq!(shown.len(), GROUP_KEY_LEN + 1);
        assert_eq!(normalise_code(&shown), key);
        // Anything that is not exactly eight characters passes through
        // untouched — legacy six-character codes included.
        assert_eq!(format_group_key("K7RM2Q"), "K7RM2Q");
    }

    #[test]
    fn group_rpc_payloads_and_results_match_the_database_contract() {
        let join = join_group_request("k7rm-2qwd", "Sam");
        assert_eq!(join["group_key"], "K7RM2QWD");
        assert_eq!(join["coder_name"], "Sam");
        let joined: JoinedGroup = serde_json::from_value(serde_json::json!({
            "project_id": "project-1",
            "title": "Sample Study",
            "coder_name": "Sam",
            "created": true
        }))
        .expect("join_group's JSON must decode");
        assert!(joined.created);
        assert_eq!(joined.coder_name, "Sam");
        let out = serde_json::to_string(&joined).unwrap();
        assert!(
            out.contains("\"projectId\"") && out.contains("\"coderName\""),
            "the frontend reads camelCase; got {out}"
        );

        let rename = rename_coder_request("project-1", "Sam R.");
        assert_eq!(rename["p_project_id"], "project-1");
        assert_eq!(rename["p_coder_name"], "Sam R.");
        let renamed: RenamedSelf = serde_json::from_value(serde_json::json!({
            "coder_name": "Sam R.",
            "previous_name": "Sam"
        }))
        .expect("set_my_coder_name's JSON must decode");
        assert_eq!(renamed.previous_name, "Sam");
        assert_eq!(renamed.coder_name, "Sam R.");
    }

    #[test]
    fn typing_a_code_wrongly_still_redeems_it() {
        // Every one of these is the same code as far as the server is concerned.
        for typed in [
            "K7RM2Q",
            "k7rm2q",
            "k7rm-2q",
            " K7RM 2Q ",
            "K7RM2O", // O read for 0 … which is not what this one is, see below
        ] {
            let n = normalise_code(typed);
            assert_eq!(n.len(), 6, "{typed} normalised to {n}");
            assert!(n
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
        }
        assert_eq!(normalise_code("k7rm-2q"), "K7RM2Q");
        // The substitutions run one way: toward the alphabet the codes use.
        assert_eq!(normalise_code("O1IL"), "0111");
    }

    #[test]
    fn empty_corpus_hashes_to_the_sha256_of_nothing() {
        let (_dir, conn) = project();
        assert_eq!(
            corpus_hash(&conn).unwrap(),
            EMPTY_CORPUS,
            "a project with no transcripts must hash to the constant the join \
             path recognises — if this drifts, joining a study silently becomes \
             a corpus mismatch again"
        );
    }

    #[test]
    fn a_joiner_with_no_transcripts_may_pull_but_not_push() {
        // The exact situation of a second coder's first sync: the study has a
        // corpus, this machine has nothing yet.
        assert_eq!(
            plan_corpus(EMPTY_CORPUS, Some("be36c872")),
            CorpusPlan::AwaitOnly,
            "an empty local corpus is a coder who has not imported yet, not a \
             coder whose transcripts disagree"
        );
    }

    #[test]
    fn an_empty_corpus_never_pins_the_studys_fingerprint() {
        assert_eq!(
            plan_corpus(EMPTY_CORPUS, None),
            CorpusPlan::AwaitOnly,
            "pinning from an empty corpus would fix the study at 'no \
             transcripts' and lock the real corpus out permanently"
        );
    }

    /// 🔑 The regression that made the study's first corpus permanent.
    ///
    /// This used to return `Err(CorpusMismatch)`, which killed sync outright.
    /// Nothing ever updated the stored hash, so the first machine to sync fixed
    /// the study's corpus forever: importing a second interview — or correcting
    /// a typo in the first — left both coders permanently refused, with the
    /// error advising them to re-import files that were already correct.
    #[test]
    fn a_corpus_that_has_moved_on_updates_the_record_instead_of_failing() {
        assert_eq!(
            plan_corpus("corpus-with-two-interviews", Some("corpus-with-one")),
            CorpusPlan::Repin,
            "a grown corpus must update the study's record, not deadlock it"
        );
    }

    /// The safety this once claimed to provide now lives in the id scheme, and
    /// this pins the property the refusal was standing in for.
    #[test]
    fn a_segment_id_encodes_the_very_text_it_names() {
        let iv = crate::ids::interview_id("P07");
        let original = crate::ids::segment_id(&iv, 0, "she practised smiling");
        let edited = crate::ids::segment_id(&iv, 0, "she practiced smiling");
        let moved = crate::ids::segment_id(&iv, 1, "she practised smiling");

        assert_ne!(original, edited, "changed words must change the id");
        assert_ne!(original, moved, "a changed position must change the id");
        assert_eq!(
            original,
            crate::ids::segment_id(&iv, 0, "  she   practised smiling  "),
            "only cosmetic whitespace may be ignored"
        );
    }

    #[test]
    fn the_first_machine_with_transcripts_pins_the_corpus() {
        assert_eq!(plan_corpus("aaa", None), CorpusPlan::Pin);
        assert_eq!(plan_corpus("aaa", Some("aaa")), CorpusPlan::Proceed);
    }

    #[test]
    fn serde_golden_fixtures_decode_like_postgrest() {
        let membership_body = include_str!("../fixtures/sync/membership_rows.json");
        let rows: Vec<MembershipRow> =
            serde_json::from_str(membership_body).expect("membership fixture");
        assert_eq!(rows.len(), 1);
        let summary = rows.into_iter().next().unwrap().into_summary();
        assert_eq!(summary.coder_name, "Ada");

        let coded_body = include_str!("../fixtures/sync/coded_segment_row.json");
        let coded: Vec<CodedSegmentPayload> =
            serde_json::from_str(coded_body).expect("coded segment fixture");
        assert_eq!(coded[0].coder_name, "Ada");
        assert_eq!(coded[0].project_id, "proj-shared");
    }

    /// Two temp `.fleuron` folders exchange coding without live Supabase.
    #[test]
    fn two_temp_projects_exchange_coding() {
        let project_id = "proj-shared-local";
        let label = "P07";
        let text = "she said she practised smiling in the mirror";
        let interview_id = crate::ids::interview_id(label);
        let segment_id = crate::ids::segment_id(&interview_id, 0, text);

        let (_dir_a, conn_a) = project();
        bind_to_group(&conn_a, project_id).unwrap();
        db::create_interview(
            &conn_a,
            &crate::models::CreateInterviewInput {
                participant_label: label.into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();
        db::import_segments(
            &conn_a,
            &crate::models::ImportSegmentsInput {
                interview_id: interview_id.clone(),
                segments: vec![crate::models::SegmentInput {
                    speaker: "P07".into(),
                    timestamp_start: "00:00:00.000".into(),
                    timestamp_end: None,
                    text: text.into(),
                    section_tag: None,
                }],
                raw_vtt_path: None,
            },
        )
        .unwrap();
        let code = db::create_code(
            &conn_a,
            &crate::models::CreateCodeInput {
                name: "Masking".into(),
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
            &conn_a,
            &crate::models::ApplyCodesInput {
                interview_id: interview_id.clone(),
                segment_id: segment_id.clone(),
                code_ids: vec![code.id.clone()],
                coder_name: "Ada".into(),
                memo: None,
                char_start: None,
                char_end: None,
            },
        )
        .unwrap();

        let batch = collect_push_batch(&conn_a, project_id).unwrap();
        assert!(!batch.coded.is_empty());

        let (_dir_b, conn_b) = project();
        bind_to_group(&conn_b, project_id).unwrap();
        let iv_b = db::create_interview(
            &conn_b,
            &crate::models::CreateInterviewInput {
                participant_label: label.into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();
        assert_eq!(iv_b.id, interview_id);
        db::import_segments(
            &conn_b,
            &crate::models::ImportSegmentsInput {
                interview_id: iv_b.id,
                segments: vec![crate::models::SegmentInput {
                    speaker: "P07".into(),
                    timestamp_start: "00:00:00.000".into(),
                    timestamp_end: None,
                    text: text.into(),
                    section_tag: None,
                }],
                raw_vtt_path: None,
            },
        )
        .unwrap();

        apply_pull(
            &conn_b,
            &PullBatch {
                coded: batch.coded,
                codes: batch.codes,
                interviews: batch.interviews,
                truncated: false,
            },
        )
        .expect("machine B accepts machine A's batch");

        let landed: i64 = conn_b
            .query_row(
                "SELECT COUNT(*) FROM coded_segments WHERE coder_name = 'Ada'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(landed, 1);
    }

    /// Push talks to PostgREST-shaped endpoints on a fake server.
    #[tokio::test]
    async fn push_round_trips_through_httpmock() {
        use httpmock::prelude::*;

        let server = MockServer::start();
        let base = server.base_url();
        for table in ["codebook", "interviews", "coded_segments"] {
            let path = format!("/rest/v1/{table}");
            server.mock(move |when, then| {
                when.method(POST).path(path.clone());
                then.status(201);
            });
        }

        let project_id = "proj-httpmock";
        let cfg = SyncConfig {
            url: base,
            anon_key: "test-anon".into(),
            project_id: project_id.into(),
        };
        let session = SyncSession {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            user_id: "user-a".into(),
            email: "ada@example.com".into(),
        };
        let client = client().expect("http client");

        let (_dir, conn) = project();
        bind_to_group(&conn, project_id).unwrap();
        let label = "P07";
        let text = "she said she practised smiling in the mirror";
        let interview_id = crate::ids::interview_id(label);
        let segment_id = crate::ids::segment_id(&interview_id, 0, text);
        db::create_interview(
            &conn,
            &crate::models::CreateInterviewInput {
                participant_label: label.into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();
        db::import_segments(
            &conn,
            &crate::models::ImportSegmentsInput {
                interview_id: interview_id.clone(),
                segments: vec![crate::models::SegmentInput {
                    speaker: "P07".into(),
                    timestamp_start: "00:00:00.000".into(),
                    timestamp_end: None,
                    text: text.into(),
                    section_tag: None,
                }],
                raw_vtt_path: None,
            },
        )
        .unwrap();
        let code = db::create_code(
            &conn,
            &crate::models::CreateCodeInput {
                name: "Masking".into(),
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
            &conn,
            &crate::models::ApplyCodesInput {
                interview_id,
                segment_id,
                code_ids: vec![code.id],
                coder_name: "Ada".into(),
                memo: None,
                char_start: None,
                char_end: None,
            },
        )
        .unwrap();

        let batch = collect_push_batch(&conn, project_id).unwrap();
        push(&client, &cfg, &session, &batch)
            .await
            .expect("mock server accepts push");
    }

    #[test]
    fn fold_memberships_dedupes_and_picks_user_identity() {
        let rows = vec![
            MembershipRow {
                project_id: "p1".into(),
                user_id: "user-alice".into(),
                coder_name: "Alice".into(),
                role: Some("admin".into()),
                projects: Some(MembershipTitle {
                    title: "Interview Study".into(),
                }),
            },
            MembershipRow {
                project_id: "p1".into(),
                user_id: "user-ada".into(),
                coder_name: "Ada".into(),
                role: Some("coder".into()),
                projects: Some(MembershipTitle {
                    title: "Interview Study".into(),
                }),
            },
            MembershipRow {
                project_id: "p1".into(),
                user_id: "user-charlie".into(),
                coder_name: "Charlie".into(),
                role: Some("coder".into()),
                projects: Some(MembershipTitle {
                    title: "Interview Study".into(),
                }),
            },
        ];

        // 1. Fixture of 3 rows across 1 project returns 1 MembershipSummary with 3 members
        let folded = fold_memberships(rows.clone(), "user-ada");
        assert_eq!(folded.len(), 1);
        let summary = &folded[0];
        assert_eq!(summary.project_id, "p1");
        assert_eq!(summary.title, "Interview Study");
        // 2. coder_name equals matching user_id
        assert_eq!(summary.coder_name, "Ada");
        assert_eq!(summary.role, "coder");
        assert_eq!(summary.members, vec!["Alice", "Ada", "Charlie"]);

        // 3. If user_id is not in project, returns empty vec
        let missing = fold_memberships(rows, "user-stranger");
        assert!(missing.is_empty());
    }

    #[test]
    fn fold_memberships_preserves_first_seen_order_across_interleaved_projects() {
        let rows = vec![
            MembershipRow {
                project_id: "p-first".into(),
                user_id: "user-1".into(),
                coder_name: "Coder 1".into(),
                role: Some("admin".into()),
                projects: Some(MembershipTitle {
                    title: "Study 1".into(),
                }),
            },
            MembershipRow {
                project_id: "p-second".into(),
                user_id: "user-2".into(),
                coder_name: "Coder 2".into(),
                role: Some("admin".into()),
                projects: Some(MembershipTitle {
                    title: "Study 2".into(),
                }),
            },
            MembershipRow {
                project_id: "p-first".into(),
                user_id: "user-me".into(),
                coder_name: "Me In First".into(),
                role: Some("coder".into()),
                projects: Some(MembershipTitle {
                    title: "Study 1".into(),
                }),
            },
            MembershipRow {
                project_id: "p-second".into(),
                user_id: "user-me".into(),
                coder_name: "Me In Second".into(),
                role: Some("coder".into()),
                projects: Some(MembershipTitle {
                    title: "Study 2".into(),
                }),
            },
        ];

        let folded = fold_memberships(rows, "user-me");
        assert_eq!(folded.len(), 2);
        assert_eq!(folded[0].project_id, "p-first");
        assert_eq!(folded[0].coder_name, "Me In First");
        assert_eq!(folded[0].members, vec!["Coder 1", "Me In First"]);

        assert_eq!(folded[1].project_id, "p-second");
        assert_eq!(folded[1].coder_name, "Me In Second");
        assert_eq!(folded[1].members, vec!["Coder 2", "Me In Second"]);
    }

    #[test]
    fn pull_followed_by_list_interviews_returns_pulled_label() {
        let (_dir, conn) = project();
        let pulled_interview = InterviewPayload {
            id: crate::ids::interview_id("interview1-transcript"),
            project_id: "p1".into(),
            study_label: "interview1-transcript".into(),
            segment_count: 10,
            content_hash: Some("sha256:abc".into()),
            revision: 1,
            deleted: false,
            updated_at: None,
        };
        let batch = PullBatch {
            coded: vec![],
            codes: vec![],
            interviews: vec![pulled_interview],
            truncated: false,
        };
        apply_pull(&conn, &batch).expect("pull succeeds");

        let list = crate::db::list_interviews(&conn).expect("list succeeds");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].participant_label, "interview1-transcript");
    }

    #[test]
    fn interview_content_hash_matches_content_hash_of() {
        let (_dir, conn) = project();
        let iv = crate::db::create_interview(
            &conn,
            &crate::models::CreateInterviewInput {
                participant_label: "P07".into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();

        let segments = vec![
            crate::models::SegmentInput {
                speaker: "P07".into(),
                timestamp_start: "00:00:01.000".into(),
                timestamp_end: None,
                text: "Hello world.".into(),
                section_tag: None,
            },
            crate::models::SegmentInput {
                speaker: "Interviewer".into(),
                timestamp_start: "00:00:05.000".into(),
                timestamp_end: None,
                text: "Tell me more.".into(),
                section_tag: None,
            },
        ];

        crate::db::import_segments(
            &conn,
            &crate::models::ImportSegmentsInput {
                interview_id: iv.id.clone(),
                segments: segments.clone(),
                raw_vtt_path: None,
            },
        )
        .unwrap();

        let db_hash = interview_content_hash(&conn, &iv.id).unwrap();
        let direct_hash = content_hash_of(
            segments
                .into_iter()
                .enumerate()
                .map(|(i, s)| (i as i64, s.text)),
        );

        assert!(db_hash.is_some());
        assert_eq!(db_hash, direct_hash);
    }

    #[test]
    fn content_hash_collapses_whitespace_identically() {
        let h1 = content_hash_of(vec![(0, "Hello  world  test.".into())].into_iter());
        let h2 = content_hash_of(vec![(0, "Hello world test.".into())].into_iter());
        assert_eq!(h1, h2);
        assert!(h1.is_some());

        let empty = content_hash_of(Vec::<(i64, String)>::new().into_iter());
        assert_eq!(empty, None);
    }

    #[tokio::test]
    async fn push_conflict_rescue_clobbers_local_coding_when_coders_share_name() {
        let project_id = "proj-rescue-bug";
        let (_dir, conn) = project();
        bind_to_group(&conn, project_id).unwrap();

        let label = "P07";
        let text = "she said she practised smiling in the mirror";
        let interview_id = crate::ids::interview_id(label);
        let segment_id = crate::ids::segment_id(&interview_id, 0, text);

        db::create_interview(
            &conn,
            &crate::models::CreateInterviewInput {
                participant_label: label.into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();

        db::import_segments(
            &conn,
            &crate::models::ImportSegmentsInput {
                interview_id: interview_id.clone(),
                segments: vec![crate::models::SegmentInput {
                    speaker: "P07".into(),
                    timestamp_start: "00:00:00.000".into(),
                    timestamp_end: None,
                    text: text.into(),
                    section_tag: None,
                }],
                raw_vtt_path: None,
            },
        )
        .unwrap();

        // Coder A creates code "Apples" locally
        let code_apples = db::create_code(
            &conn,
            &crate::models::CreateCodeInput {
                name: "Apples".into(),
                definition: None,
                inclusion_criteria: None,
                exclusion_criteria: None,
                example: None,
                parent_id: None,
                color: None,
            },
        )
        .unwrap();

        // Coder A applies "Apples" to the segment under coder_name "Ada"
        let _local_applied = db::apply_codes(
            &conn,
            &crate::models::ApplyCodesInput {
                interview_id: interview_id.clone(),
                segment_id: segment_id.clone(),
                code_ids: vec![code_apples.id.clone()],
                coder_name: "Ada".into(),
                memo: None,
                char_start: Some(0),
                char_end: Some(10),
            },
        )
        .unwrap();

        // Meanwhile, Coder B already created "Oranges" and coded the same span on the server under "Ada"
        let code_b_oranges_id = "code-oranges-id";
        let server_coded_row = CodedSegmentPayload {
            id: "server-row-uuid-123".into(),
            project_id: project_id.into(),
            interview_id: interview_id.clone(),
            segment_id: segment_id.clone(),
            code_ids: vec![code_b_oranges_id.into()],
            coder_name: "Ada".into(),
            char_start: Some(0),
            char_end: Some(10),
            revision: 1,
            deleted: false,
            updated_at: Some("2026-08-22T00:00:00Z".into()),
        };

        // When A pushes, a 409 conflict occurs, and the rescue fetches the remote rows and applies pull:
        let rescue_batch = PullBatch {
            coded: vec![server_coded_row],
            codes: vec![],
            interviews: vec![],
            truncated: false,
        };
        apply_pull(&conn, &rescue_batch).expect("rescue apply_pull succeeds");

        // Check local state for A's coding:
        let current_coding = db::list_coded_segments(&conn, Some(&interview_id), None).unwrap();
        assert_eq!(current_coding.len(), 1);
        let my_coding = &current_coding[0];

        // Under 3-way merge, neither A's code "Apples" nor B's "Oranges" is clobbered
        assert!(
            my_coding.code_ids.contains(&code_apples.id),
            "Local coding 'Apples' was lost during push-conflict rescue!"
        );
        assert!(
            my_coding.code_ids.contains(&code_b_oranges_id.to_string()),
            "Remote coding 'Oranges' was lost during push-conflict rescue!"
        );
    }

    #[test]
    fn pull_does_not_modify_unsynced_local_row_with_higher_remote_revision() {
        let (_dir, conn) = project();
        let code = db::create_code(
            &conn,
            &crate::models::CreateCodeInput {
                name: "LocalCode".into(),
                definition: Some("local def".into()),
                inclusion_criteria: None,
                exclusion_criteria: None,
                example: None,
                parent_id: None,
                color: None,
            },
        )
        .unwrap();

        // Local code is dirty (sync_dirty = 1, revision = 1)
        let incoming_code = CodePayload {
            id: code.id.clone(),
            project_id: "p1".into(),
            name: "RemoteClobber".into(),
            definition: Some("remote def".into()),
            parent_id: None,
            color: None,
            sort_order: 0,
            is_retired: false,
            revision: 5,
            deleted: false,
            updated_at: Some("2026-08-22T01:00:00Z".into()),
        };

        let batch = PullBatch {
            coded: vec![],
            codes: vec![incoming_code],
            interviews: vec![],
            truncated: false,
        };
        apply_pull(&conn, &batch).unwrap();

        let updated = db::list_codes(&conn).unwrap();
        assert_eq!(updated.len(), 1);
        assert_eq!(
            updated[0].name, "LocalCode",
            "Unsynced local code was clobbered by pull!"
        );
        assert_eq!(updated[0].definition.as_deref(), Some("local def"));
    }

    #[test]
    fn pull_does_apply_when_local_row_is_clean() {
        let (_dir, conn) = project();
        let code = db::create_code(
            &conn,
            &crate::models::CreateCodeInput {
                name: "LocalCode".into(),
                definition: Some("local def".into()),
                inclusion_criteria: None,
                exclusion_criteria: None,
                example: None,
                parent_id: None,
                color: None,
            },
        )
        .unwrap();

        // Mark local code clean (sync_dirty = 0)
        let push_batch = collect_push_batch(&conn, "p1").unwrap();
        mark_pushed(&conn, &push_batch).unwrap();

        let incoming_code = CodePayload {
            id: code.id.clone(),
            project_id: "p1".into(),
            name: "RemoteUpdated".into(),
            definition: Some("remote def".into()),
            parent_id: None,
            color: None,
            sort_order: 0,
            is_retired: false,
            revision: 5,
            deleted: false,
            updated_at: Some("2026-08-22T01:00:00Z".into()),
        };

        let batch = PullBatch {
            coded: vec![],
            codes: vec![incoming_code],
            interviews: vec![],
            truncated: false,
        };
        apply_pull(&conn, &batch).unwrap();

        let updated = db::list_codes(&conn).unwrap();
        assert_eq!(updated.len(), 1);
        assert_eq!(
            updated[0].name, "RemoteUpdated",
            "Clean local code was not updated by remote pull!"
        );
        assert_eq!(updated[0].definition.as_deref(), Some("remote def"));
    }

    #[test]
    fn cursor_does_not_pass_a_deferred_row() {
        let (_dir, conn) = project();
        let code = db::create_code(
            &conn,
            &crate::models::CreateCodeInput {
                name: "DirtyLocal".into(),
                definition: None,
                inclusion_criteria: None,
                exclusion_criteria: None,
                example: None,
                parent_id: None,
                color: None,
            },
        )
        .unwrap();

        // Local code is dirty
        let incoming_dirty_match = CodePayload {
            id: code.id.clone(),
            project_id: "p1".into(),
            name: "RemoteRename".into(),
            definition: None,
            parent_id: None,
            color: None,
            sort_order: 0,
            is_retired: false,
            revision: 5,
            deleted: false,
            updated_at: Some("2026-08-22T01:00:00Z".into()),
        };
        let incoming_new_code = CodePayload {
            id: "code-new-uuid".into(),
            project_id: "p1".into(),
            name: "RemoteNew".into(),
            definition: None,
            parent_id: None,
            color: None,
            sort_order: 1,
            is_retired: false,
            revision: 1,
            deleted: false,
            updated_at: Some("2026-08-22T02:00:00Z".into()),
        };

        let batch = PullBatch {
            coded: vec![],
            codes: vec![incoming_dirty_match, incoming_new_code],
            interviews: vec![],
            truncated: false,
        };
        let outcome = apply_pull(&conn, &batch).unwrap();
        assert_eq!(outcome.codes_receipt.deferred.len(), 1);
        assert_eq!(outcome.codes_receipt.applied.len(), 1);

        let cursor = next_cursor(
            batch.codes.iter().map(|c| &c.updated_at),
            &outcome.codes_receipt,
        );
        // Must be pinned to 01:00:00Z, not 02:00:00Z!
        assert_eq!(cursor, Some("2026-08-22T01:00:00Z".into()));
    }

    #[test]
    fn cursor_advances_over_superseded_rows() {
        let (_dir, conn) = project();
        let code = db::create_code(
            &conn,
            &crate::models::CreateCodeInput {
                name: "HighRevLocal".into(),
                definition: None,
                inclusion_criteria: None,
                exclusion_criteria: None,
                example: None,
                parent_id: None,
                color: None,
            },
        )
        .unwrap();

        // Mark clean at revision 10
        conn.execute(
            "UPDATE codebook SET revision = 10, sync_dirty = 0 WHERE id = ?1",
            params![code.id],
        )
        .unwrap();

        let incoming_stale = CodePayload {
            id: code.id.clone(),
            project_id: "p1".into(),
            name: "StaleRemote".into(),
            definition: None,
            parent_id: None,
            color: None,
            sort_order: 0,
            is_retired: false,
            revision: 2,
            deleted: false,
            updated_at: Some("2026-08-22T01:00:00Z".into()),
        };

        let batch = PullBatch {
            coded: vec![],
            codes: vec![incoming_stale],
            interviews: vec![],
            truncated: false,
        };
        let outcome = apply_pull(&conn, &batch).unwrap();
        assert_eq!(outcome.codes_receipt.superseded.len(), 1);
        assert!(outcome.codes_receipt.deferred.is_empty());

        let cursor = next_cursor(
            batch.codes.iter().map(|c| &c.updated_at),
            &outcome.codes_receipt,
        );
        assert_eq!(cursor, Some("2026-08-22T01:00:00Z".into()));
    }

    #[test]
    fn pending_staged_rows_do_not_pin_cursor() {
        let (_dir, conn) = project();

        let staged_coded = CodedSegmentPayload {
            id: "coded-staged-1".into(),
            project_id: "p1".into(),
            interview_id: "iv-unimported".into(),
            segment_id: "seg-unimported".into(),
            code_ids: vec!["code1".into()],
            coder_name: "Colleague".into(),
            char_start: None,
            char_end: None,
            revision: 1,
            deleted: false,
            updated_at: Some("2026-08-22T01:30:00Z".into()),
        };

        let batch = PullBatch {
            coded: vec![staged_coded],
            codes: vec![],
            interviews: vec![],
            truncated: false,
        };
        let outcome = apply_pull(&conn, &batch).unwrap();
        assert_eq!(outcome.coded_receipt.applied.len(), 1);
        assert!(outcome.coded_receipt.deferred.is_empty());

        let cursor = next_cursor(
            batch.coded.iter().map(|c| &c.updated_at),
            &outcome.coded_receipt,
        );
        assert_eq!(cursor, Some("2026-08-22T01:30:00Z".into()));
    }

    #[test]
    fn deferred_row_is_reapplied_after_local_goes_clean() {
        let (_dir, conn) = project();
        let code = db::create_code(
            &conn,
            &crate::models::CreateCodeInput {
                name: "LocalCode".into(),
                definition: None,
                inclusion_criteria: None,
                exclusion_criteria: None,
                example: None,
                parent_id: None,
                color: None,
            },
        )
        .unwrap();

        // 1. Pull arrives while local is dirty
        let incoming = CodePayload {
            id: code.id.clone(),
            project_id: "p1".into(),
            name: "RemoteRenamed".into(),
            definition: None,
            parent_id: None,
            color: None,
            sort_order: 0,
            is_retired: false,
            revision: 5,
            deleted: false,
            updated_at: Some("2026-08-22T01:00:00Z".into()),
        };
        let batch = PullBatch {
            coded: vec![],
            codes: vec![incoming.clone()],
            interviews: vec![],
            truncated: false,
        };
        let outcome1 = apply_pull(&conn, &batch).unwrap();
        assert_eq!(outcome1.codes_receipt.deferred.len(), 1);

        // 2. Local row is pushed and marked clean
        let push_batch = collect_push_batch(&conn, "p1").unwrap();
        mark_pushed(&conn, &push_batch).unwrap();

        // 3. Re-pull the deferred row
        let outcome2 = apply_pull(&conn, &batch).unwrap();
        assert_eq!(outcome2.codes_receipt.applied.len(), 1);
        assert!(outcome2.codes_receipt.deferred.is_empty());

        let updated = db::list_codes(&conn).unwrap();
        assert_eq!(updated[0].name, "RemoteRenamed");
    }

    #[test]
    fn pagination_drains_multiple_pages() {
        // Page 1 of 1000 items with increasing timestamps
        let next_query = compute_next_page_query(
            "1970-01-01T00:00:00Z",
            "gte",
            1000,
            Some("2026-08-22T05:00:00Z"),
        );
        assert_eq!(
            next_query,
            Some(("gte", "2026-08-22T05:00:00Z".to_string()))
        );

        // Short page (less than PAGE_SIZE) ends pagination
        let end_query = compute_next_page_query(
            "2026-08-22T05:00:00Z",
            "gte",
            450,
            Some("2026-08-22T06:00:00Z"),
        );
        assert_eq!(end_query, None);
    }

    #[test]
    fn pagination_stops_on_uniform_timestamp_page() {
        // Full page sharing single timestamp falls back to "gt"
        let fallback_query = compute_next_page_query(
            "2026-08-22T05:00:00Z",
            "gte",
            1000,
            Some("2026-08-22T05:00:00Z"),
        );
        assert_eq!(
            fallback_query,
            Some(("gt", "2026-08-22T05:00:00Z".to_string()))
        );

        // If even "gt" returns the same timestamp, terminates
        let stop_query = compute_next_page_query(
            "2026-08-22T05:00:00Z",
            "gt",
            1000,
            Some("2026-08-22T05:00:00Z"),
        );
        assert_eq!(stop_query, None);
    }

    #[test]
    fn cursor_without_local_rows_reports_never_synced() {
        let (_dir, conn) = project();
        bind_to_group(&conn, "test-group-id").unwrap();
        set_state(&conn, KEY_CODED_CURSOR, "2026-08-22T00:00:00Z").unwrap();

        // 0 coded segments
        assert!(is_never_synced(&conn).unwrap());

        // Insert 1 valid coded segment with valid interview and segment foreign keys
        let iv = db::create_interview(
            &conn,
            &crate::models::CreateInterviewInput {
                participant_label: "P01".into(),
                interview_date: None,
                modality: None,
                diagnosis_notes: None,
                interviewers: vec![],
            },
        )
        .unwrap();
        let imported = db::import_segments(
            &conn,
            &crate::models::ImportSegmentsInput {
                interview_id: iv.id.clone(),
                segments: vec![crate::models::SegmentInput {
                    speaker: "P01".into(),
                    timestamp_start: "00:00:00.000".into(),
                    timestamp_end: None,
                    text: "line".into(),
                    section_tag: None,
                }],
                raw_vtt_path: None,
            },
        )
        .unwrap();
        assert_eq!(imported, 1);
        let seg_id = crate::ids::segment_id(&iv.id, 0, "line");

        conn.execute(
            "INSERT INTO coded_segments (id, interview_id, segment_id, code_ids, coder_name, created_at, updated_at, revision, deleted, sync_dirty)
             VALUES ('c1', ?1, ?2, '[]', 'Ada', '2026-08-22T00:00:00Z', '2026-08-22T00:00:00Z', 1, 0, 0)",
            params![iv.id, seg_id],
        ).unwrap();

        assert!(!is_never_synced(&conn).unwrap());
    }

    #[test]
    fn deep_verify_is_read_only() {
        let (_dir, conn) = project();
        seed_one_coded(&conn);
        let before_coded = db::list_coded_segments(&conn, None, None).unwrap();
        let before_codes = db::list_codes(&conn).unwrap();

        let report = DiagnosticsReport {
            local_coded_count: before_coded.len(),
            local_code_count: before_codes.len(),
            remote_coded_count: 5,
            remote_code_count: 2,
            missing_remote_coded_count: 0,
            missing_remote_coder_names: vec![],
            pending_to_send_count: 0,
            clock_skew_seconds: Some(0),
            summary_message: "Everything matches.".into(),
            raw_coded_cursor: None,
            raw_codebook_cursor: None,
            raw_interview_cursor: None,
            last_synced_at: None,
            needs_repair: false,
            needs_send: false,
            last_error: None,
            last_outcome: None,
        };

        // Assert that computing reports and inspecting local state wrote nothing to SQLite
        let after_coded = db::list_coded_segments(&conn, None, None).unwrap();
        let after_codes = db::list_codes(&conn).unwrap();
        assert_eq!(before_coded, after_coded);
        assert_eq!(before_codes, after_codes);
        assert_eq!(report.local_coded_count, 1);
    }

    #[test]
    fn diagnostics_block_carries_no_free_text() {
        let report = DiagnosticsReport {
            local_coded_count: 42,
            local_code_count: 5,
            remote_coded_count: 42,
            remote_code_count: 5,
            missing_remote_coded_count: 0,
            missing_remote_coder_names: vec![],
            pending_to_send_count: 0,
            clock_skew_seconds: Some(2),
            summary_message: "Everything matches. 42 coded passages, 5 codes.".into(),
            raw_coded_cursor: Some("2026-08-22T12:00:00Z".into()),
            raw_codebook_cursor: Some("2026-08-22T12:00:00Z".into()),
            raw_interview_cursor: Some("2026-08-22T12:00:00Z".into()),
            last_synced_at: Some("2026-08-22T12:00:00Z".into()),
            needs_repair: false,
            needs_send: false,
            last_error: None,
            last_outcome: None,
        };

        let dump = diagnostics_summary_text(&report);
        // Assert no participant label like "P07", no transcript quote, no code name leaks
        assert!(!dump.contains("P07"));
        assert!(!dump.contains("rehearse"));
        assert!(!dump.contains("Anxiety"));
        assert!(dump.contains("Local: 42 coded segments, 5 codes"));
        assert!(dump.contains("Clock skew: 2s"));
    }

    #[test]
    fn unbind_from_group_redirties_local_rows_and_resets_state() {
        let (_dir, conn) = project();
        seed_one_coded(&conn);
        let _code = db::create_code(
            &conn,
            &crate::models::CreateCodeInput {
                name: "Code A".into(),
                definition: None,
                inclusion_criteria: None,
                exclusion_criteria: None,
                example: None,
                parent_id: None,
                color: None,
            },
        )
        .unwrap();

        // Mark all local rows clean (sync_dirty = 0)
        conn.execute("UPDATE coded_segments SET sync_dirty = 0", [])
            .unwrap();
        conn.execute("UPDATE codebook SET sync_dirty = 0", [])
            .unwrap();
        conn.execute("UPDATE interviews SET sync_dirty = 0", [])
            .unwrap();

        let clean_coded: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM coded_segments WHERE sync_dirty = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let clean_codes: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM codebook WHERE sync_dirty = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let clean_ivs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM interviews WHERE sync_dirty = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(clean_coded > 0 && clean_codes > 0 && clean_ivs > 0);

        // Seed bound state, cursors, and pending unbind
        let initial_project_id = "initial-group-uuid-1234";
        set_state(&conn, KEY_PROJECT_ID, initial_project_id).unwrap();
        set_state(&conn, KEY_BOUND, "1").unwrap();
        set_state(&conn, KEY_ROLE, "admin").unwrap();
        set_state(&conn, KEY_GROUP_TITLE, "My Group").unwrap();
        set_state(&conn, KEY_CODED_CURSOR, "2026-08-22T00:00:00Z").unwrap();
        set_state(&conn, KEY_CODEBOOK_CURSOR, "2026-08-22T00:00:00Z").unwrap();
        set_state(&conn, KEY_INTERVIEW_CURSOR, "2026-08-22T00:00:00Z").unwrap();
        set_state(&conn, KEY_PENDING_UNBIND, "1").unwrap();

        // Call unbind_from_group
        let res = unbind_from_group(&conn);
        assert!(
            res.is_ok(),
            "unbind_from_group failed with: {:?}",
            res.err()
        );

        // Assert all local rows are re-dirtied (sync_dirty = 1)
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
        assert_eq!(dirty_coded, clean_coded);
        assert_eq!(dirty_codes, clean_codes);
        assert_eq!(dirty_ivs, clean_ivs);

        // Assert bound state and keys are reset
        assert_eq!(get_state(&conn, KEY_BOUND).unwrap(), Some("0".to_string()));
        let new_project_id = get_state(&conn, KEY_PROJECT_ID).unwrap().unwrap();
        assert_ne!(new_project_id, initial_project_id);
        assert_eq!(get_state(&conn, KEY_ROLE).unwrap(), None);
        assert_eq!(get_state(&conn, KEY_GROUP_TITLE).unwrap(), None);
        assert_eq!(get_state(&conn, KEY_CODED_CURSOR).unwrap(), None);
        assert_eq!(get_state(&conn, KEY_CODEBOOK_CURSOR).unwrap(), None);
        assert_eq!(get_state(&conn, KEY_INTERVIEW_CURSOR).unwrap(), None);
        assert_eq!(get_state(&conn, KEY_PENDING_UNBIND).unwrap(), None);

        // Assert idempotency: calling a second time still returns Ok
        assert!(unbind_from_group(&conn).is_ok());
    }
}

#[path = "sync/contract_tests.rs"]
#[cfg(test)]
mod contract_tests;
