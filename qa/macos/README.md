# Fleuron macOS QA Runner

This runner verifies the matching Fleuron DMG without installing the app or bypassing Gatekeeper. It uses macOS-built-in `hdiutil`, `codesign`, and `PlistBuddy` to verify the disk image, mounted bundle, app version, bundle signature, and packaged-app `--selftest`.

## Release asset

Every release includes this directory as `Fleuron_<version>_macos-qa-runner.zip`. Keep the generated `release.json` next to `Invoke-FleuronQA.sh`: it pins the expected release version and rejects a canonical DMG filename for a different release.

## Run

1. Unzip the macOS QA runner archive.
2. Download the matching `Fleuron_<version>_universal.dmg` from the same GitHub Release.
3. Run:

   ```bash
   bash ./Fleuron-macOS-QA-Runner/Invoke-FleuronQA.sh \
     --candidate ./Fleuron_<version>_universal.dmg
   ```

The runner writes `fleuron-qa-evidence/SUMMARY.md` and raw command logs in the current directory. It mounts the DMG read-only, runs the packaged app's self-test, then detaches the DMG. It never copies the app to Applications, changes quarantine flags, opens Security & Privacy settings, or advises bypassing any OS security control.

When used from a source checkout instead of a release asset, provide a canonical DMG filename or pass `--expected-version X.Y.Z`.
