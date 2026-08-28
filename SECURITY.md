# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.2.x | Yes |
| < 1.2 | No |

## Reporting a vulnerability

**Use GitHub's private "Report a vulnerability" flow** on this repository (Security tab → Report a vulnerability). Do not open a public issue for security reports.

Please include: affected version/build commit, platform, reproduction steps or PoC, and expected vs actual behavior. You will get an acknowledgement; fixes land as patch releases and are announced in the changelog.

## What we ask reporters NOT to do

- No automated scanning against hosted sync infrastructure beyond public endpoints
- No reports that require violating any organization's policies or local law

## Security model notes

Fleuron signs updates with Tauri/minisign and publishes GitHub artifact attestations plus `SHA256SUMS.txt` per release. There is no Apple Developer ID/notarization and no Windows Authenticode publisher signature — the OS publisher warning shown on first launch is expected, and the [install guide](docs/INSTALLING.md) documents exactly which warnings are ordinary versus reasons to stop.
