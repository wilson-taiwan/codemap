//! The sync server this build points at, when nobody has configured one.
//!
//! # What this removes
//!
//! The second coder used to receive an address, a 208-character JWT and a
//! 32-character invitation code, and had to get all three into the right boxes
//! on a machine they were setting up for the first time. Every character was a
//! chance to fail in a way that surfaces much later as an opaque 404. There is
//! one study and one server, so the app can simply know where it lives, and the
//! only thing a person carries is the six characters that identify *them*.
//!
//! # Where the values come from
//!
//! Both are read from the environment **at compile time**, so neither is
//! committed to this repository. Set them when building anything anyone else
//! will install:
//!
//! ```sh
//! export CODEMAP_SYNC_URL='https://<project>.supabase.co'
//! export CODEMAP_SYNC_ANON_KEY='eyJ…'      # the anon key, never service_role
//! ```
//!
//! ⚠️ **`CODEMAP_SYNC_ANON_KEY` must be the *anon* key.** Decode the JWT payload
//! and check that `role` reads `anon` before using it. A `service_role` key
//! bypasses row-level security completely, and baking one into a binary handed
//! to other people would expose the whole database. The anon key is safe here
//! precisely because it grants nothing on its own: `schema.sql` reduces every
//! policy to project membership, an account with no membership reads an empty
//! database, and membership comes only from redeeming an invitation. **The
//! invitation is the gate, not the key.**
//!
//! # When they are absent
//!
//! A build with neither variable set falls back to asking for the address and
//! key in the sync sheet, exactly as before — so a local `cargo build` or
//! `tauri dev` still works with nothing configured. Stored preferences always
//! take precedence over both, which is what lets one installed copy be
//! repointed at a different study without a rebuild.

/// Treat an unset variable and an empty one identically.
///
/// CI writes `CODEMAP_SYNC_ANON_KEY: ${{ secrets.… }}`, and a secret that does
/// not exist arrives as the empty string rather than as nothing at all. Without
/// this the app would compile in an empty key and fail at runtime against the
/// server instead of falling back to asking.
const fn non_empty(value: Option<&str>) -> Option<&str> {
    match value {
        Some(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

/// The study's Supabase project, e.g. `https://<ref>.supabase.co`.
pub const URL: Option<&str> = non_empty(option_env!("CODEMAP_SYNC_URL"));

/// The anon key for the project above. See the module note before changing.
pub const ANON_KEY: Option<&str> = non_empty(option_env!("CODEMAP_SYNC_ANON_KEY"));
