# Privacy and permissions

**Short version: transcript text and memos stay local. Collaboration syncs your account, study, codebook, and coding metadata over encrypted HTTPS/WSS.**

This page is the exact disclosure. The in-app **Trust & permissions** panel and `src/content/trust-and-permissions.ts` carry the same content; contract tests fail if any of the three drifts.

## Data boundary, exactly

| Category | Synced / sent when collaboration is used | Kept local |
| --- | --- | --- |
| Account and access | Account email and Supabase auth metadata; entitlement state; study membership, role, coder display name, device/readiness and sync metadata | Refresh token file itself; local app preferences and paths |
| Study / interview identity | Shared study identity/title; de-identified study/participant label; interview ID; segment count; deterministic content hash; revisions/timestamps/deletion state | Transcript raw files and text; filenames/paths; interview date; interviewer names; diagnosis fields |
| Codebook | Code IDs; name; definition; inclusion criteria; exclusion criteria; examples; parent/hierarchy; color; sort order; retired/deleted state; versions/timestamps | Nothing in these text fields is automatically de-identified — researchers must author them safely |
| Coding | Coder attribution; interview/segment/code IDs; character start/end offsets; add/remove/deletion state; conflict/version/timestamp metadata | Verbatim quote text; coding memos and analytic memos |
| Output and diagnostics | Nothing automatically | Exports, project databases/backups, crash logs, device-local activity; these leave only if you deliberately copy/upload them |

Three consequences worth saying plainly:

- Study/participant labels and every codebook text field sync word-for-word. Write them de-identified from the start.
- HTTPS/WSS encrypts transport. That protects data on the wire; it does not make synced contents unknowable to the service operator.
- Fleuron supports a research protocol; it cannot certify compliance of any kind.

## Where files live

- New studies default to a local working library: `~/Fleuron` on macOS, `%USERPROFILE%\Fleuron` on Windows. Cloud-synced Documents/Desktop folders are avoided on purpose.
- Existing projects are never moved by an update.
- Exports and backups are written where you choose.

## Permissions model

Choosing a file or folder with your OS's own picker is the entire permission ask — no pre-prompts, no permission wizard. macOS may show one truthful prompt when you pick inside protected locations (Documents/Desktop/Downloads/network/removable volumes); Windows may enforce Controlled Folder Access there. Denial recovery is in-app and offers choose-another-folder paths; Fleuron never asks for Full Disk Access and never suggests disabling ransomware protection.

Capabilities Fleuron **does not request**: camera, microphone, screen recording, Accessibility, location, contacts, calendar, notifications, Bluetooth, local-network discovery, Full Disk Access, inbound network listener/firewall exception.

## Network behavior

| Purpose | Endpoint | Protocol | Default |
| --- | --- | --- | --- |
| Update checks | api.github.com (wilson-taiwan/fleuron releases) | Outbound HTTPS | On; disable in Settings → Update checks |
| Update download/install after you approve | github.com releases | Outbound HTTPS | Only on your action |
| Collaboration sync (account + study/codebook/coding metadata) | Configured Supabase service | Outbound HTTPS/WSS | Only when collaborating |

No inbound ports, no firewall exception needed, no telemetry, no automatic crash upload.

## Stored sign-in

Only your refresh token is stored; never your password.

- **macOS:** a mode-0600 `session.json` in the app data folder. Keychain is intentionally unused while builds are ad-hoc signed (rebuilds change the signature and would re-prompt).
- **Windows:** DPAPI ciphertext in `session.dpapi`, bound to your current Windows user on this machine. v1.1 plaintext files migrate silently on first load and are removed only after the protected copy verifies.

Signing out deletes every stored session artifact.

## Crash logs

Crash logs stay on this machine unless you copy them somewhere. They may contain file paths or diagnostic messages — review and redact before sharing in an issue.
