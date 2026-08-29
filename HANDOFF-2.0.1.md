# Fleuron 2.0.1 — Current Status

## Prepared locally

- The source tree is versioned as **2.0.1**.
- The Windows QA round-2 repairs are included: retrying backup restore, a real updater transaction harness, ASCII PowerShell enforcement, and corrected silent-installer exit handling.
- The QA runners stay maintainer-only and are **not** published as release assets. Each one wipes the default study library (`~/Fleuron` / `%USERPROFILE%\Fleuron`) with no confirmation prompt, which makes a public release page the wrong place for them. Match a runner to a release by checking out that release's tag and using its `qa/` directory.
- The release workflow still syntax-checks and self-checks both runners; it no longer stages, uploads, inventories, checksums, or attests them. The published inventory is six assets.

## Local validation

TypeScript, frontend/build/E2E, Rust, PowerShell parser/self-check, release and installer contracts, workflow validation, and simulated archive layouts passed locally.

## Still required before release

Run the Win11 VM harness against the 2.0.1 candidate and inspect:

- `selftest_backup-restore`
- `silent_install_exit_code_zero`
- `fleuron_v2_installed_after_update`
- `updater_timeout_aborts_cleanly`

The live in-app 1.2.0 → 2.0.0 click-through remains a manual check. Nothing has been tagged, pushed, or released.
