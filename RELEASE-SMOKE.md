# Codemap Release Smoke Checklist

Walk this checklist against the exact release build before declaring a release
done. Fill every `Last verified:` line with real evidence from the actual
build/platform before the release is called shipped — **NOT RUN** means the
release is not ready.

> All evidence is redacted and synthetic: no real study data, participant text,
> or account identifiers may be recorded here or in the release notes.

- **Version:** 1.1.0
- **Commit:** pending tag (see git log at release time)
- **Platform / build:** macOS universal (build pending release run)
- **Date (last run):** 2026-08-26
- **Verifier:** implementation agent (pre-release); Wilson for updater/install items

## 1. Offline / accountless local path

- [x] Create a local project with no account
  (`Last verified: 2026-08-26 — existing e2e workspace-journey + local unit suite; no sync configured`)

## 2. Beta disclosure

- [x] Notice visible on the create-account surface
  (`Last verified: 2026-08-26 — beta-notice unit guard asserts AccountForm renders BetaNotice`)
- [x] Notice visible on the Study & sync sheet
  (`Last verified: 2026-08-26 — beta-notice unit guard asserts SyncSheet renders BetaNotice`)
- [x] Copy reads: hosted sync is free during beta, subscription after;
      transcripts stay local; local tools remain free; beta joiners keep
      founder pricing
  (`Last verified: 2026-08-26 — beta-notice.test.ts single-source copy assertions`)

## 3. Silent auto-activation (new + existing)

- [x] New study activates to protocol 2 automatically with no button/confirm
  (`Last verified: 2026-08-26 — e2e sync-diagnostics default fixture: active chip, no Activate button/heading; API smoke: create → register → empty activate → protocol 2`)
- [x] Create-account + new study returns with "Real-time collaboration active"
  (`Last verified: 2026-08-26 — store regression: createGroup activates after first sync`)
- [x] Existing eligible protocol-1 admin study becomes protocol 2 on open,
      no sheet interaction
  (`Last verified: 2026-08-26 — store regression + useAppInit awaited auto-activate; server readiness gate verified in pgTAP`)

## 4. Not-ready protocol-1 study

- [x] Multi-member study with one member not ready stays protocol 1 with
      passive "turns on automatically" copy; Protocol-1 coding still syncs
  (`Last verified: 2026-08-26 — e2e fixture=sync-not-ready: passive copy, no control, diagnostics legacy; not-ready readiness asserted in store regression`)
- [ ] After the last member registers, the admin's next trigger activates
  (`Last verified: NOT RUN — requires two live clients on one study`)

## 5. Entitlement behavior (beta is dormant for real accounts)

- [x] Active-beta account create / join / push / pull succeeds
  (`Last verified: 2026-08-26 — local-API smoke: create 201, register ready, activate protocol 2, apply applied/conflicted, pull head 2`)
- [x] Synthetic inactive account: local coding + pull succeed; create, join,
      and push fail with the friendly subscription message
  (`Last verified: 2026-08-26 — local-API smoke: all writes return 403 CODEMAP_ENTITLEMENT_REQUIRED, pull 200; friendly mapping in contract_tests; UI copy visible in e2e`)

## 6. Diagnostics

- [x] Collapsed Technical details show protocol / generation / server head for
      protocol 2, legacy state for a protocol-1 study
  (`Last verified: 2026-08-26 — e2e sync-diagnostics both fixtures`)
- [x] No raw error, token, or SQL leakage in any surface
  (`Last verified: 2026-08-26 — contract tests assert Display never contains the token; e2e asserts no protocol jargon on the main sheet`)

## 7. First launch / platforms

- [ ] macOS fresh install reports 1.1.0 in About (`Last verified: NOT RUN`)
- [ ] Windows fresh install reports 1.1.0 (`Last verified: NOT RUN`)

## 8. Updater path (previous release → this release)

- [ ] The updater delivers 1.1.0 to windows and macOS and both restart cleanly
      with local project data intact (`Last verified: NOT RUN`)

## 9. Integration evidence (local/staging stack)

- [x] Entitlement gate and auto-activation cooperate on the same local stack:
      empty-study activation, current `join_group`, legacy `redeem_invite`,
      direct project create, protocol-1 upserts all carry the same friendly
      message when the caller is inactive
  (`Last verified: 2026-08-26 — 48-assertion pgTAP suite over the live local stack + local-API smoke; empty activation covered by both`)
