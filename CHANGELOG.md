# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.0]

### Added

- **In-app diagnostic report:** In About modal, users can generate a comprehensive plain-text diagnostic report covering application version, install integrity (poisoned nested directory detection), library project counts, sync status, storage health (WAL/SHM and stranded staging DB detection), updater state, and redacted crash logs. A mandatory scrollable preview is displayed before copying or saving to file.
- **External read-only diagnostic probe:** Added `support/` directory with `support/fleuron-probe.sh` (macOS) and `support/Get-FleuronProbe.ps1` (Windows PowerShell 5.1/pwsh) for users whose app fails to start. Both probes are strictly read-only, make zero network calls, and enforce the same 120-character allowlist redaction rule on crash payloads.
- **Diagnostics intake:** Updated install-help issue template with an optional diagnostic report field and linked troubleshooting instructions in installation and support guides.

### Infrastructure

- Clarified separation between user diagnostics (`support/` and in-app) and destructive maintainer test suites (`qa/`). The QA runners remain maintainer-only and are never published as release assets.

## [2.0.1]

### Fixed

- Backup restore retries the final database replacement when Windows briefly
  holds an SQLite handle, removes failed staging files, and reports actionable
  WAL/SHM diagnostics without deleting the live database.
- Windows installer QA distinguishes a healthy silent install from its required
  zero exit code and exercises the updater timeout-abort path before the real
  updater transaction.

### Infrastructure

- The QA runners are maintainer tools and are deliberately **not** published as
  release assets. Each one begins by wiping the default study library
  (`~/Fleuron` / `%USERPROFILE%\Fleuron`) with no confirmation prompt, so a
  release page is the wrong place to offer them. To verify a specific release,
  check out its tag and use the `qa/` directory from that commit. A contract
  test fails the build if a runner archive is added back to the release
  inventory or advertised in the release notes.
- The release inventory is therefore six assets, not eight.

## [2.0.0]

Codemap is now **Fleuron**.

This is a rename, not a rewrite — the app, its data model, and its sync
protocol are unchanged. It is a major version because the application
identifier changed, which means 2.0.0 installs alongside a 1.x install rather
than updating it.

### Changed

- Projects are now created as `.fleuron` folders. Existing `.codemap` and
  `.qcproj` projects open unchanged.
- The application data directory moved from `app.codemap.desktop` to
  `study.fleuron.desktop`. A 1.x install's recent-projects list, preferences,
  and signed-in session do not carry over; sign in again after upgrading.
- Backups are written as `.fleuronbak`. Existing `.codemapbak` files still import.
- The default library for new projects moved from `~/Codemap` to `~/Fleuron`
  (`%USERPROFILE%\Fleuron` on Windows). Projects already on disk are never moved.
- Build and CI environment variables are now `FLEURON_*`.

## [1.2.0] - 2026-08-27

### Added

- **Trust & permissions center** in-app: Files & permissions, Local vs collaboration, build provenance, and system warning disclosure in one reachable surface.
- **Collaboration disclosure** on onboarding's collaborate card, Join Study, and account creation: names exactly what leaves the machine — account email plus study, codebook, and coding records — with a link to the privacy guide; transcript text and memos always stay local.
- **Quiet update controls**: an automatic-checks toggle in settings; automatic up-to-date/failure outcomes are silent, manual failure and available updates stay visible.
- **Intent-first local onboarding**: create and code in a local study with no account; credentials and collaboration only enter once you choose collaboration.
- **Windows DPAPI storage** for the refresh token (`session.dpapi`, current-user DPAPI); legacy plaintext `session.json` migrates silently then deletes.
- **Public trust documentation**: nontechnical install guidance (`docs/INSTALLING.md`), exact privacy and permission disclosure (`docs/PRIVACY-AND-PERMISSIONS.md`), Support, Security, and IT-deployment guides for managed machines, signing activation notes, and install/bug-report issue templates.

### Changed

- **New projects default to a personal library** (`~/Codemap` on macOS, `%USERPROFILE%\Codemap` on Windows) instead of the protected Documents folder; existing paths are preserved and unavailable recents stay visible.
- **Folder access is consent at use**: native file/folder pickers are the consent; a denied picker shows a truthful inline choose-another-folder / how-to-fix state instead of retrying; the folder-scan disclosure appears before the scan; no Full Disk Access recommendation.
- **One restrained confirmation system** replaces scattered browser and app-owned prompts for destructive or destination choices.
- **macOS bundle** is sealed as a complete bundle with explicit ad-hoc signing and truthful file-purpose strings — Codemap is ad-hoc signed and un-notarized (no Apple Developer ID), so first launch legitimately triggers Gatekeeper with documented Open Anyway guidance.
- **Windows installer contract** is documented and machine-checked: current-user install, no elevation/prompt, SmartScreen / Unknown publisher / Controlled Folder Access / WebView2 / Mark-of-the-Web behavior in plain language.

### Infrastructure

- Rust CI now runs on `macos-latest` **and** `windows-latest`. A release-contract suite (49 tests) pins packaging and trust invariants, including fail-closed presence of the real-app selftest in every platform job with a negative fixture.
- New manual **candidate pipeline** (`candidate.yml`, non-publishing); the release workflow is draft-only with a provenance/attestation job and exact-asset inventory.
- The packaged real-app `--selftest` now runs in every candidate and release platform job and fails the run on any failure. The in-app selftest gained five suites — study lifecycle, transcript import, coding roundtrip, export artifacts, backup-restore — for 11 pass / 1 skip.
- Playwright E2E now triggers on **every push to `main`**; four deviant-path specs and a seeded monkey pass were added, and the dev mock gained `sync-error`, `server-conflict`, `auth-error`, and `slow` fault fixtures.
- Rust: `salvage_legacy_v1_state_for_v2` now keys salvaged coding per code (a migrated Protocol-1 span carrying two codes produces two correct entities), and backup staging filenames are UUID-suffixed so concurrent snapshots cannot collide.
- Server migration verification scripts (static + negative-fixture self-check) are restored as CI gates; this version makes no server or schema change (schema stays at 10).

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
