use crate::models::StudyReadiness;
use rusqlite::Connection;
use std::path::Path;

pub fn study_readiness(path_str: &str) -> StudyReadiness {
    let path = Path::new(path_str);
    let db_path = path.join("project.db");
    if !db_path.exists() {
        return StudyReadiness::Unlinked;
    }

    let conn = match Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(c) => c,
        Err(_) => return StudyReadiness::Unlinked,
    };

    // 1. Missing transcripts: interviews where no transcript_segments exist
    let missing_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM interviews i
             WHERE i.deleted = 0
               AND NOT EXISTS (
                 SELECT 1 FROM transcript_segments s WHERE s.interview_id = i.id
               )",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    if missing_count > 0 {
        return StudyReadiness::MissingTranscripts {
            missing_count: missing_count as usize,
        };
    }

    // 2. Diverged: any interview whose local hash differs from remote_content_hash
    if let Ok(missing_ivs) = crate::sync::missing_transcripts(&conn) {
        if missing_ivs.iter().any(|m| m.mismatched) {
            return StudyReadiness::Diverged;
        }
    }

    // 3. Behind: count of rows where sync_dirty = 1
    let dirty_coded: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM coded_segments WHERE sync_dirty = 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let dirty_codebook: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM codebook WHERE sync_dirty = 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let dirty_ivs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM interviews WHERE sync_dirty = 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let total_dirty = dirty_coded + dirty_codebook + dirty_ivs;
    if total_dirty > 0 {
        return StudyReadiness::Behind {
            behind_count: total_dirty as usize,
        };
    }

    StudyReadiness::Ready
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_reports_ready_for_clean_db() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("project.db");
        let conn = Connection::open(&db_path).unwrap();
        crate::db::init_schema(&conn).unwrap();

        let r = study_readiness(&temp.path().to_string_lossy());
        assert_eq!(r, StudyReadiness::Ready);
    }

    #[test]
    fn readiness_reports_missing_transcripts() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("project.db");
        let conn = Connection::open(&db_path).unwrap();
        crate::db::init_schema(&conn).unwrap();

        conn.execute(
            "INSERT INTO interviews (id, participant_label, created_at, updated_at) VALUES ('i1', 'P01', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        let r = study_readiness(&temp.path().to_string_lossy());
        assert_eq!(r, StudyReadiness::MissingTranscripts { missing_count: 1 });
    }
}
