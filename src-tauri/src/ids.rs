//! Identifiers derived from content rather than randomness.
//!
//! # Why these are not random
//!
//! Two coders hold the same transcripts and exchange coding decisions as ids —
//! "segment `a3f2…` was coded `c9e1…`". That only means anything if the same
//! passage carries the same id on both machines.
//!
//! With `Uuid::new_v4()` it did not. Each import minted fresh random ids, so
//! importing one transcript on two laptops produced two disjoint sets of ids
//! for identical words, and the only way to make them agree was to build the
//! project once and ship the whole database to the other coder. That is what
//! made a handoff file mandatory for every new interview.
//!
//! Deriving the id from the content removes the need entirely: import the same
//! file in two places, get the same ids, and the only thing that ever has to be
//! shared is the transcript itself.
//!
//! # Normalisation is the whole contract
//!
//! Two machines agree only if they normalise identically, so both helpers below
//! run their inputs through the same whitespace fold used by the corpus hash.
//! Anything that changes normalisation is a breaking change to every existing
//! project's ids and must be treated as such.
//!
//! Domain separators (`\0` and a versioned prefix) keep the fields unambiguous:
//! without them `("ab", "c")` and `("a", "bc")` hash alike, and a future scheme
//! change could not be told from this one.

use sha2::{Digest, Sha256};

const INTERVIEW_DOMAIN: &str = "codemap.interview.v1";
const SEGMENT_DOMAIN: &str = "codemap.segment.v1";

/// Collapse runs of whitespace and trim, so cosmetic differences between two
/// exports of the same transcript do not produce different ids.
pub fn normalize(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Render a digest in UUID shape.
///
/// Not a real UUID — no version or variant bits — but every id in this app is
/// an opaque string in a `TEXT` column, and keeping the familiar shape means
/// existing ids and derived ones are indistinguishable at a glance in logs,
/// exports and the database.
fn to_uuid_shape(digest: &[u8]) -> String {
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The id for an interview, derived from its study label.
///
/// The label is the tokenised study ID the protocol already requires in every
/// working file — `P07`, not a name — so both coders type the same thing and
/// arrive at the same id. Case and spacing are normalised because "P07" and
/// "p07 " are the same participant and a coder should not have to know that
/// the id generator cares.
///
/// Deliberately **not** salted with the project id: that would force joining a
/// shared project before importing anything, and a collision between two
/// unrelated projects that both call someone `P07` is harmless — coding rows
/// are scoped by project on the server and by file locally.
pub fn interview_id(study_label: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(INTERVIEW_DOMAIN.as_bytes());
    hasher.update([0u8]);
    hasher.update(normalize(&study_label.to_lowercase()).as_bytes());
    to_uuid_shape(&hasher.finalize())
}

/// The id for one passage of a transcript.
///
/// Includes the text, not just the position. Position alone would mean that
/// inserting a line near the top of a re-transcribed file silently shifted
/// every id below it onto the wrong words — the worst possible failure, since
/// ids are opaque and nothing would look wrong. Including the text means a
/// changed passage becomes a *different* passage, which surfaces as coding that
/// no longer attaches rather than coding attached to the wrong thing.
pub fn segment_id(interview_id: &str, index: i64, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(SEGMENT_DOMAIN.as_bytes());
    hasher.update([0u8]);
    hasher.update(interview_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(index.to_string().as_bytes());
    hasher.update([0u8]);
    hasher.update(normalize(text).as_bytes());
    to_uuid_shape(&hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_label_gives_the_same_interview_on_any_machine() {
        assert_eq!(interview_id("P07"), interview_id("P07"));
        assert_eq!(interview_id("P07"), interview_id(" p07 "));
        assert_ne!(interview_id("P07"), interview_id("P08"));
    }

    #[test]
    fn the_same_passage_gives_the_same_segment_on_any_machine() {
        let iv = interview_id("P07");
        let a = segment_id(&iv, 4, "she practised smiling in the mirror");
        let b = segment_id(&iv, 4, "she  practised   smiling in the mirror");
        assert_eq!(a, b, "whitespace is not content");

        assert_ne!(
            a,
            segment_id(&iv, 5, "she practised smiling in the mirror"),
            "position is part of identity"
        );
        assert_ne!(
            a,
            segment_id(&iv, 4, "she practised smiling in the hallway"),
            "changed words must become a different passage, never the same one"
        );
        assert_ne!(
            a,
            segment_id(
                &interview_id("P08"),
                4,
                "she practised smiling in the mirror"
            ),
            "the same words in two interviews are two passages"
        );
    }

    #[test]
    fn fields_cannot_run_together() {
        let iv = interview_id("P07");
        // Without a separator between index and text these would collide.
        assert_ne!(segment_id(&iv, 1, "23abc"), segment_id(&iv, 12, "3abc"));
    }

    #[test]
    fn ids_are_uuid_shaped() {
        let id = interview_id("P07");
        assert_eq!(id.len(), 36);
        assert_eq!(id.matches('-').count(), 4);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
    }
}
