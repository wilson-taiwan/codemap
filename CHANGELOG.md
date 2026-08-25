# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
