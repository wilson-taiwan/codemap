# Signing activation runbook (maintainer checklist)

A future release may add a **personal** Apple Developer ID / notarization and/or a Windows Authenticode certificate. This page is the activation checklist for that day — it deliberately contains no pipeline, no secrets handling, and no institutional/organization routes.

## macOS — Apple Developer ID + notarization

Prerequisite: personal Apple Developer Program membership is active.

- [ ] Create a Developer ID Application certificate in Xcode/account portal
- [ ] Replace `signingIdentity: "-"` with the real identity name
- [ ] Add hardened runtime if desired and re-verify the whole bundle still seals cleanly
- [ ] Notarize + staple: `xcrun notarytool submit` then `xcrun stapler staple`
- [ ] Update `docs/INSTALLING.md`: delete the expected-warning section; document zero-warning launch
- [ ] Update `scripts/verify-mac-bundle.sh`: require `Authority=Developer ID`, real TeamIdentifier, and flip the spctl check from "expected reject" to "must pass"
- [ ] Recapture all macOS screenshots from signed builds before replacing docs imagery
- [ ] Regenerate candidates; rerun the full gate set

## Windows — Authenticode

Prerequisite: an OV/EV code-signing certificate you personally control.

- [ ] Sign both installer and updater archive post-build (`signtool sign /fd SHA256`)
- [ ] Note: EV certificates immediately carry SmartScreen reputation; OV reputation builds up over downloads
- [ ] Update `docs/INSTALLING.md` SmartScreen section to match observed behavior for signed builds
- [ ] Extend `scripts/nsis-template.test.mjs`/release-contract tests: fail when a shipping artifact is unsigned once signing is active
- [ ] Recapture SmartScreen screenshots only from signed builds

## What must NEVER change, signed or not

- Updater minisign keys and verification stay in place alongside any new signature
- Prohibited-guidance contract tests keep passing (no bypass advice anywhere)
- The publisher-verification notice wording updates to reflect reality — never disappears silently
