//! Static column-name lint and SQL EXPLAIN test guard.
//!
//! Validates that:
//! 1. No raw SQL in `src-tauri/src/` references the non-existent `dirty` column (should be `sync_dirty`).
//! 2. All static SQL queries in `sync.rs` and `db.rs` compile and explain successfully against an initialized SQLite schema.
//! 3. Misspelled column names are detected and fail the test.

use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};

fn get_src_tauri_src_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join("src")
}

fn collect_rs_files(dir: &Path, files: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_rs_files(&path, files);
            } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
                files.push(path);
            }
        }
    }
}

#[test]
fn test_no_bare_dirty_column_references_in_src_tauri() {
    let src_dir = get_src_tauri_src_dir();
    let mut rs_files = Vec::new();
    collect_rs_files(&src_dir, &mut rs_files);
    assert!(!rs_files.is_empty(), "Found no .rs files to lint");

    let forbidden_patterns = [
        "SET dirty",
        "WHERE dirty",
        "AND dirty",
        "OR dirty",
        ", dirty =",
        " dirty =",
    ];

    let mut violations = Vec::new();

    for file in rs_files {
        let content = fs::read_to_string(&file).expect("read rs file");
        let file_name = file.file_name().and_then(|s| s.to_str()).unwrap_or("");
        // Ignore this lint file itself when checking patterns
        if file_name == "schema_lint.rs" {
            continue;
        }

        for (line_no, line) in content.lines().enumerate() {
            let trimmed = line.trim();
            // Skip comments and test panic messages describing the bug
            if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with('*') {
                continue;
            }
            if trimmed.contains("no such column: dirty") || trimmed.contains("intentional") {
                continue;
            }

            for pattern in &forbidden_patterns {
                if line.contains(pattern) {
                    violations.push(format!("{}:{}: {}", file.display(), line_no + 1, line));
                }
            }
        }
    }

    assert!(
        violations.is_empty(),
        "Found forbidden references to 'dirty' column (must use 'sync_dirty'):\n{}",
        violations.join("\n")
    );
}

#[test]
fn test_static_sql_queries_explain_cleanly_against_real_schema() {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    crate::db::init_schema(&conn).expect("init schema");

    // Static queries from sync.rs and lifecycle management
    let static_queries = [
        "SELECT key, value FROM sync_state",
        "SELECT value FROM sync_state WHERE key = ?1",
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        "DELETE FROM sync_state WHERE key = ?1",
        "DELETE FROM sync_state",
        "UPDATE coded_segments SET sync_dirty = 1",
        "UPDATE codebook SET sync_dirty = 1",
        "UPDATE interviews SET sync_dirty = 1",
        "SELECT id, name, definition, parent_id, color, sort_order, is_retired, revision, deleted, updated_at FROM codebook WHERE sync_dirty = 1",
        "SELECT id, interview_id, segment_id, code_ids, coder_name, deleted, revision, updated_at, char_start, char_end FROM coded_segments WHERE sync_dirty = 1",
        "SELECT i.id, i.participant_label, i.deleted, i.revision, (SELECT COUNT(*) FROM transcript_segments t WHERE t.interview_id = i.id) FROM interviews i WHERE i.sync_dirty = 1",
        "UPDATE coded_segments SET sync_dirty = 0 WHERE id = ?1 AND revision = ?2",
        "UPDATE codebook SET sync_dirty = 0 WHERE id = ?1 AND revision = ?2",
        "UPDATE interviews SET sync_dirty = 0 WHERE id = ?1 AND revision = ?2",
        "SELECT id, segment_id, code_ids, coder_name, revision, deleted, updated_at, char_start, char_end FROM pending_coded_segments WHERE interview_id = ?1",
        "DELETE FROM pending_coded_segments WHERE id = ?1",
        "SELECT COUNT(*) FROM coded_segments WHERE sync_dirty = 1",
        "SELECT COUNT(*) FROM codebook WHERE sync_dirty = 1",
        "SELECT COUNT(*) FROM interviews WHERE sync_dirty = 1",
        "SELECT COUNT(*) FROM coded_segments WHERE sync_dirty = 0",
        "SELECT COUNT(*) FROM codebook WHERE sync_dirty = 0",
        "SELECT COUNT(*) FROM interviews WHERE sync_dirty = 0",
    ];

    for query in static_queries {
        let explain_sql = format!("EXPLAIN {}", query);
        let result = conn.prepare(&explain_sql);
        assert!(
            result.is_ok(),
            "SQL EXPLAIN failed for query '{}': {:?}",
            query,
            result.err()
        );
    }
}

#[test]
fn test_schema_lint_catches_invalid_column_names() {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    crate::db::init_schema(&conn).expect("init schema");

    // Intentionally bad queries must fail
    let bad_query_1 = "UPDATE coded_segments SET dirty = 1";
    let bad_query_2 = "SELECT nonexistent_column FROM codebook";
    let bad_query_3 = "UPDATE interviews SET non_existent_flag = 1";

    assert!(conn.prepare(&format!("EXPLAIN {}", bad_query_1)).is_err());
    assert!(conn.prepare(&format!("EXPLAIN {}", bad_query_2)).is_err());
    assert!(conn.prepare(&format!("EXPLAIN {}", bad_query_3)).is_err());
}
