# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.0] - 2026-08-26

### Added

- **Real-time collaboration status** on the Study & sync sheet: an "active" chip when collaborative sync is on, a plain-language "turns on automatically" note while the team catches up, and a friendly message when sync is unavailable.
- **Beta disclosure** on account creation and the Study & sync sheet (and README): hosted sync is free while Codemap is in beta, becomes subscription-based afterwards, local/offline tools stay free, and beta joiners keep founder pricing.
- **Per-user sync entitlement substrate** on the server (dormant during the free beta — every account is entitled).

### Changed

- **Sync Protocol 2 activates automatically** for new and existing eligible studies: no button, no confirmation, no protocol jargon. The server's own readiness gate (every current member updated and synced once) still decides when; a not-ready study keeps working on the previous protocol until then.
- **Error mapping** for subscription-gated sync paths: create, join, redeem, and push on a lapsed account show one clear friendly message instead of generic permission or network text.
- **Protocol internals** (protocol number, generation, server head) moved into the collapsed Technical details block of the Sync Diagnostics panel, kept for support only.

### Infrastructure

- One additive migration adds the entitlement store, beta auto-grant + backfill, and the write-path gate; server schema certification stays at 10 and the app remains fully usable offline.
- Static migration verification and negative-fixture self-check restored, wired into CI; the release workflow now runs a fail-closed `validate` job (version identity, migration verification, typecheck, unit tests, build, Rust format/clippy/tests) before any platform build.
- Local Supabase verification scripts restored (`verify-supabase-migrations.sh`, `test-local-supabase-v2.sh`, `check-server-schema.sh`).

---

## [1.0.0] - 2026-08-25

### Initial Public Release

Codemap 1.0.0 is the first public, open-source release of the desktop qualitative coding environment for reflexive thematic analysis.

#### Features

- **Offline-First Core**: Fully functional standalone desktop workspace backed by local SQLite storage (`.codemap` project directories).
- **Interactive Coding**:
  - Drag-to-select phrase highlight coding with contextual floating action bubbles.
  - Whole-turn passage coding with intuitive toggle interactions.
  - Multi-code overlap rendering with customizable color palettes.
- **Living Codebook**:
  - Full codebook management: create, rename, recolor, merge, split, and retire codes.
  - Interactive passage drawer showing all quotes assigned to a code in real time.
- **Transcript Parsing & Ingestion**:
  - Automatic format detection and parsing for WebVTT (`.vtt`), SubRip (`.srt`), speaker-labeled plain text (`.txt`), Microsoft Word (`.docx`), and tabular transcripts (`.csv`).
- **Reflexive Memoing**:
  - Highlighting-level notes and interview-wide memos preserved locally on disk.
- **Multi-Coder Sync (Protocol v2)**:
  - Optional multi-user synchronization via self-hosted or managed Supabase backend.
  - Strict privacy boundary: code definitions and coded segment hashes sync while transcript texts and private memos stay strictly local.
- **Export Formats**:
  - Export coded passages and codebooks to CSV, formatted Markdown, standalone HTML summaries, and DOCX documents.
- **Platform Support**:
  - Native builds and installers for macOS (Apple Silicon and Intel) and Windows 10/11.
