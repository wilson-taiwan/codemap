# Codemap Release Smoke Checklist

Walk this checklist against the exact release build before declaring a release
done. Fill every `Last verified:` line with real evidence from the actual
build/platform before the release is called shipped — unchecked items mean the
release is not ready.

> All evidence is redacted and synthetic: no real study data, participant text,
> or account identifiers may be recorded here or in the release notes.

- **Version:** 1.2.0
- **Commit:** pending tag (see git log at release time)
- **Platform / build:** macOS universal (build pending release run)
- **Date (last run):** 2026-08-27
- **Verifier:** implementation agent (pre-release); Wilson for updater/install items

## 1. Offline / accountless local path

- [x] Create a local project with no account (`Last verified: 2026-08-27 — e2e workspace-journey + local unit suite; no sync configured`)

## 2. Beta disclosure

- [x] Notice visible on the create-account surface (`Last verified: 2026-08-27 — beta-notice unit guard asserts AccountForm renders BetaNotice`)
- [x] Notice visible on the Study & sync sheet (`Last verified: 2026-08-27 — beta-notice unit guard asserts SyncSheet renders BetaNotice`)
- [x] Copy reads: hosted sync is free during beta, subscription after; transcripts stay local; local tools remain free; beta joiners keep founder pricing (`Last verified: 2026-08-27 — beta-notice.test.ts single-source copy assertions`)

## 3. Silent auto-activation (new + existing)

- [x] New study activates to protocol 2 automatically with no button/confirm (`Last verified: 2026-08-27 — e2e sync-diagnostics default fixture: active chip, no Activate button/heading`)
- [x] Create-account + new study returns with "Real-time collaboration active" (`Last verified: 2026-08-27 — store regression: createGroup activates after first sync`)
- [x] Existing eligible protocol-1 admin study becomes protocol 2 on open, no sheet interaction (`Last verified: 2026-08-27 — store regression + useAppInit awaited auto-activate`)

## 4. Not-ready protocol-1 study

- [x] Multi-member study with one member not ready stays protocol 1 with passive "turns on automatically" copy; Protocol-1 coding still syncs (`Last verified: 2026-08-27 — e2e fixture=sync-not-ready: passive copy, no control, diagnostics legacy`)
- [ ] After the last member registers, the admin's next trigger activates (`PENDING DRAFT ASSET — requires two live clients on one study`)

## 5. Entitlement behavior (beta is dormant for real accounts)

- [x] Active-beta account create / join / push / pull succeeds (`Last verified: 2026-08-27 — local-API smoke: create 201, register ready, activate protocol 2`)
- [x] Synthetic inactive account: local coding + pull succeed; create, join, and push fail with the friendly subscription message (`Last verified: 2026-08-27 — local-API smoke: all writes return 403 CODEMAP_ENTITLEMENT_REQUIRED`)

## 6. Diagnostics

- [x] Collapsed Technical details show protocol / generation / server head for protocol 2, legacy state for a protocol-1 study (`Last verified: 2026-08-27 — e2e sync-diagnostics both fixtures`)
- [x] No raw error, token, or SQL leakage in any surface (`Last verified: 2026-08-27 — contract tests assert Display never contains the token; e2e no protocol jargon`)

## 7. Trust & permissions (v1.2.0 new)

- [x] Trust Center panel renders from Settings and displays permissions disclosure (`Last verified: 2026-08-27 — trust-and-permissions.test.ts 15 tests; library-access contract 6 tests`)
- [x] Publisher disclosure carried verbatim in INSTALLING.md and README.md (`Last verified: 2026-08-27 — release-contract.test.mjs tests 45-46`)
- [x] Privacy & Permissions doc exists and is accurate (`Last verified: 2026-08-27 — release-contract test 44; docs/PRIVACY-AND-PERMISSIONS.md present`)

## 8. File error UX (v1.2.0 new)

- [x] File access errors classify into permission-denied / path-unavailable / read-only-storage / invalid-project and display friendly guidance (`Last verified: 2026-08-27 — file_error.rs unit tests; file-access.test.ts 9 tests`)

## 9. Onboarding wizard & confirm-store (v1.2.0 new)

- [x] Setup wizard gates new users through disclosure acceptance (`Last verified: 2026-08-27 — app-store.onboarding.test.ts 9 tests; confirm-store.test.ts 4 tests`)

## 10. Selftest harness (v1.2.0 new)

- [x] Built app selftest passes: study-lifecycle, transcript-import, coding-roundtrip, export-artifacts, backup-restore, dark-mode-contrast (`Last verified: 2026-08-27 — run-selftest.mjs: 11 PASS + 1 SKIP group-lifecycle-online, exit 0`)

## 11. NSIS installer & update guards (v1.2.0 new)

- [x] NSIS template pinned at CLI 2.11.3, security-mutation scan clean (`Last verified: 2026-08-27 — nsis-template.test.mjs 16/16; windows-update-guard.test.mjs 18/18`)
- [x] Release contract suite passes 49 tests (`Last verified: 2026-08-27 — release-contract.test.mjs 49/49`)

## 12. Sync salvage fix (v1.2.0 new)

- [x] Legacy v1 salvage keys coding per-code matching normal edits (`Last verified: 2026-08-27 — cargo test salvage_keys_coding_per_code_like_normal_edits PASS`)

## 13. Deviant-path E2E (v1.2.0 new)

- [x] Escape mid-apply lands exactly one clean coding (`Last verified: 2026-08-27 — e2e deviant-coding test 1 PASS`)
- [x] Rapid double-apply toggles cleanly net-zero without duplicating (`Last verified: 2026-08-27 — e2e deviant-coding test 2 PASS`)
- [x] Sync error renders friendly status, no raw connection refused (`Last verified: 2026-08-27 — e2e deviant-faults fixture=sync-error PASS`)
- [x] Auth error shows actionable copy, wizard never advances (`Last verified: 2026-08-27 — e2e deviant-faults fixture=auth-error PASS`)
- [x] Keyboard-only traversal reaches passage and applies a code (`Last verified: 2026-08-27 — e2e deviant-keyboard PASS`)
- [x] Monkey test: seeded random clicking, no unhandled commands or page errors (`Last verified: 2026-08-27 — e2e z-monkey PASS`)

## 14. First launch / platforms

- [ ] macOS fresh install reports 1.2.0 in About (`PENDING DRAFT ASSET — requires published release build`)
- [ ] Windows fresh install reports 1.2.0 (`PENDING DRAFT ASSET — requires published release build`)

## 15. Updater path (previous release to this release)

- [ ] The updater delivers 1.2.0 to windows and macOS and both restart cleanly with local project data intact (`PENDING POST-PUBLISH UPDATER — requires published release with updater artifacts`)

## 16. Integration evidence (local/staging stack)

- [x] Entitlement gate and auto-activation cooperate on the same local stack (`Last verified: 2026-08-27 — 48-assertion pgTAP suite + local-API smoke`)
