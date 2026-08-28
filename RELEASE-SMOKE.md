# Fleuron Release Smoke Checklist

Walk this checklist against the exact release build before declaring a release
done. Fill every `Last verified:` line with real evidence from the actual
build/platform before the release is called shipped — unchecked items mean the
release is not ready.

> All evidence is redacted and synthetic: no real study data, participant text,
> or account identifiers may be recorded here or in the release notes.

- **Version:** 2.0.0
- **Commit:** pending tag (see git log at release time)
- **Platform / build:** not yet built for 2.0.0
- **Date (last run):** not run for 2.0.0
- **Verifier:** unassigned — 2.0.0 has no smoke evidence yet

## 1. Offline / accountless local path

- [ ] Create a local project with no account (`Last verified: `)

## 2. Beta disclosure

- [ ] Notice visible on the create-account surface (`Last verified: `)
- [ ] Notice visible on the Study & sync sheet (`Last verified: `)
- [ ] Copy reads: hosted sync is free during beta, subscription after; transcripts stay local; local tools remain free; beta joiners keep founder pricing (`Last verified: `)

## 3. Silent auto-activation (new + existing)

- [ ] New study activates to protocol 2 automatically with no button/confirm (`Last verified: `)
- [ ] Create-account + new study returns with "Real-time collaboration active" (`Last verified: `)
- [ ] Existing eligible protocol-1 admin study becomes protocol 2 on open, no sheet interaction (`Last verified: `)

## 4. Not-ready protocol-1 study

- [ ] Multi-member study with one member not ready stays protocol 1 with passive "turns on automatically" copy; Protocol-1 coding still syncs (`Last verified: `)
- [ ] After the last member registers, the admin's next trigger activates (`PENDING DRAFT ASSET — requires two live clients on one study`)

## 5. Entitlement behavior (beta is dormant for real accounts)

- [ ] Active-beta account create / join / push / pull succeeds (`Last verified: `)
- [ ] Synthetic inactive account: local coding + pull succeed; create, join, and push fail with the friendly subscription message (`Last verified: `)

## 6. Diagnostics

- [ ] Collapsed Technical details show protocol / generation / server head for protocol 2, legacy state for a protocol-1 study (`Last verified: `)
- [ ] No raw error, token, or SQL leakage in any surface (`Last verified: `)

## 7. Trust & permissions (v1.2.0 new)

- [ ] Trust Center panel renders from Settings and displays permissions disclosure (`Last verified: `)
- [ ] Publisher disclosure carried verbatim in INSTALLING.md and README.md (`Last verified: `)
- [ ] Privacy & Permissions doc exists and is accurate (`Last verified: `)

## 8. File error UX (v1.2.0 new)

- [ ] File access errors classify into permission-denied / path-unavailable / read-only-storage / invalid-project and display friendly guidance (`Last verified: `)

## 9. Onboarding wizard & confirm-store (v1.2.0 new)

- [ ] Setup wizard gates new users through disclosure acceptance (`Last verified: `)

## 10. Selftest harness (v1.2.0 new)

- [ ] Built app selftest passes: study-lifecycle, transcript-import, coding-roundtrip, export-artifacts, backup-restore, dark-mode-contrast (`Last verified: `)

## 11. NSIS installer & update guards (v1.2.0 new)

- [ ] NSIS template pinned at CLI 2.11.3, security-mutation scan clean (`Last verified: `)
- [ ] Release contract suite passes 49 tests (`Last verified: `)

## 12. Sync salvage fix (v1.2.0 new)

- [ ] Legacy v1 salvage keys coding per-code matching normal edits (`Last verified: `)

## 13. Deviant-path E2E (v1.2.0 new)

- [ ] Escape mid-apply lands exactly one clean coding (`Last verified: `)
- [ ] Rapid double-apply toggles cleanly net-zero without duplicating (`Last verified: `)
- [ ] Sync error renders friendly status, no raw connection refused (`Last verified: `)
- [ ] Auth error shows actionable copy, wizard never advances (`Last verified: `)
- [ ] Keyboard-only traversal reaches passage and applies a code (`Last verified: `)
- [ ] Monkey test: seeded random clicking, no unhandled commands or page errors (`Last verified: `)

## 14. First launch / platforms

- [ ] macOS fresh install reports 2.0.0 in About (`PENDING DRAFT ASSET — requires published release build`)
- [ ] Windows fresh install reports 2.0.0 (`PENDING DRAFT ASSET — requires published release build`)

## 15. Updater path (previous release to this release)

- [ ] The updater delivers 2.0.0 to windows and macOS and both restart cleanly with local project data intact (`PENDING POST-PUBLISH UPDATER — requires published release with updater artifacts`)

## 16. Integration evidence (local/staging stack)

- [ ] Entitlement gate and auto-activation cooperate on the same local stack (`Last verified: `)

## 17. Rename verification (2.0.0 only)

- [ ] Win11 VM: clean install of `Fleuron_2.0.0_x64-setup.exe` succeeds (`Last verified: `)
- [ ] Win11 VM: app launches, creates a project, and the project opens on relaunch (`Last verified: `)
- [ ] Win11 VM: a `.codemap` folder from before the rename still opens (`Last verified: `)
- [ ] Win11 VM: upgrade over an installed 1.2.0 — confirm it installs **alongside**, does not corrupt the 1.2.0 install, and Add/Remove Programs shows both (`Last verified: `)
- [ ] macOS: `Fleuron.app` launches, creates `~/Library/Application Support/study.fleuron.desktop/`, and `~/Fleuron` is the default new-project location (`Last verified: `)
