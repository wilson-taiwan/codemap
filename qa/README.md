# Fleuron Windows VM QA Runner

Automated QA test runner for verifying Fleuron releases on Windows 11 virtual machines.

## Overview

The QA runner is written in pure PowerShell 5.1 (standard with Windows 11) with zero runtime dependencies (no Node, npm, or Git needed in the VM). It performs an unattended verification pass across fresh installation, installed-binary selftests, crash sweeps, legacy project compatibility, and updater transactions, followed by a numbered manual checklist.

## Release asset

Every release includes this runner as `Fleuron_<version>_windows-qa-runner.zip`. Unzip it beside the matching installer and keep its generated `release.json` file in place: the runner reads that file and refuses a candidate whose canonical filename indicates a different version. When running from the repository rather than a release asset, it derives the expected version from `Fleuron_X.Y.Z_x64-setup.exe` or accepts `-ExpectedVersion X.Y.Z`.

## Quick Start (VM Execution)

1. **Copy runner to VM:** Drag the unpacked `Fleuron-Windows-QA-Runner/` folder into your Windows 11 VM.
2. **Obtain Candidate Installer:** Place the matching `Fleuron_X.Y.Z_x64-setup.exe` in the VM.
3. **Run in PowerShell:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\Fleuron-Windows-QA-Runner\Invoke-FleuronQA.ps1 -Candidate .\Fleuron_X.Y.Z_x64-setup.exe
   ```
4. **Review Evidence:**
   - Open `qa-evidence\SUMMARY.md` for the test table and diagnostics.
   - Complete the numbered items under `## MANUAL — <N> rows for you`.
   - Drag `qa-evidence\` back to the host machine for records.

## CLI Arguments

| Parameter | Description | Default |
|---|---|---|
| `-Candidate <path>` | Path to the candidate installer executable (`Fleuron_X.Y.Z_x64-setup.exe`). | Mandatory |
| `-ExpectedVersion <ver>` | Expected candidate version when the filename is noncanonical; release assets normally resolve this from `release.json`. | Optional |
| `-Previous <path>` | Path to the previous release installer (`Codemap_1.2.0_x64-setup.exe`). If omitted, downloaded from GitHub. | Optional |
| `-PreviousVersion <ver>` | Version tag of the baseline installer to download when `-Previous` is omitted. | `"1.2.0"` |
| `-OutputDirectory <path>` | Target folder for `SUMMARY.md`, `evidence.json`, and `raw/`. Rotates existing folders if present. | `qa-evidence` |
| `-Online` | Opt-in switch to run cloud/sync selftests against staging Supabase. Requires `qa.env.ps1` in the runner folder. | Disabled |
| `-SkipUpdater` | Skip the simulated updater transaction leg. | Disabled |
| `-SelfCheck` | Run automated self-checks of runner modules against offline fixtures (used by CI). | Disabled |

## Test Legs

1. **Wipe (`wipe`):** Provably clears all Fleuron and Codemap AppData, LocalAppData, and Registry uninstall entries, asserting 0 survivors. Sets up synthetic canaries to detect accidental data loss.
2. **Fresh Install (`fresh_install`):** Installs candidate silently (`/S`), verifies binary attributes, shortcuts, registry keys, and runs the installed executable's `--selftest` suite (12 suites).
3. **Crash Sweep (`crash_sweep`):** Scans `%APPDATA%\study.fleuron.desktop\crashes\crash.log`, `%LOCALAPPDATA%\CrashDumps\*.dmp`, and Windows Error Reporting (WER) logs.
4. **Relaunch (`relaunch`):** Confirms installed binary boots cleanly and closes without hanging.
5. **Legacy Projects (`legacy`):** Synthesizes flat and nested `.codemap` study folders under paths with spaces and verifies command-line opening.
6. **Updater Simulation (`updater`):** Installs Codemap 1.2.0, seeds user project data, and drives candidate upgrade with real `/FLEURON_*` parameters. Captures full end-state diagnostics.
7. **Online (`online`):** Dot-sources `qa.env.ps1`, passes `--require-online`, and tests real-time collaboration and DPAPI token persistence across restarts.

## Online Staging Setup (`qa.env.ps1` in the runner folder)

When using `-Online`, create `qa.env.ps1` beside `Invoke-FleuronQA.ps1` (gitignored in a source checkout) with the following environment variables:

```powershell
$env:FLEURON_STAGING_SUPABASE_URL = "https://your-project.supabase.co"
$env:FLEURON_STAGING_SUPABASE_ANON_KEY = "your-anon-key"
$env:FLEURON_STAGING_OWNER_EMAIL = "owner@example.com"
$env:FLEURON_STAGING_OWNER_PASSWORD = "password"
$env:FLEURON_STAGING_JOINER_EMAIL = "joiner@example.com"
$env:FLEURON_STAGING_JOINER_PASSWORD = "password"
```
