#!/usr/bin/env bash
# Verify the EXACT release DMG artifact, not a pre-DMG build directory.
#
# Attaches <dmg> read-only to a unique mount point, locates exactly one
# Fleuron.app inside, runs scripts/verify-mac-bundle.sh against that mounted
# copy with the expected version + build commit, and always detaches.
set -euo pipefail

DMG="${1:?usage: verify-mac-artifact.sh <dmg> <version> <build-commit>}"
VERSION="${2:?usage: verify-mac-artifact.sh <dmg> <version> <build-commit>}"
COMMIT="${3:?usage: verify-mac-artifact.sh <dmg> <version> <build-commit>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ -f "$DMG" ]] || { echo "Error: no DMG at $DMG"; exit 1; }

echo "==> Checking disk image"
hdiutil imageinfo "$DMG" >/dev/null || { echo "Error: unreadable/corrupt disk image"; exit 1; }
image_format="$(hdiutil imageinfo "$DMG" | awk '/Format:/{print $2; exit}')"
echo "    Format: ${image_format:-unknown}"

MOUNT_DIR="$(mktemp -d /tmp/fleuron-dmg-verify.XXXXXX)"
# Declared before the trap: under `set -u` an attach failure would otherwise
# make cleanup die on an unbound DEV_ENTRY, hiding hdiutil's real error and
# leaking the mountpoint directory.
DEV_ENTRY=""
cleanup() {
  if [[ -n "$DEV_ENTRY" ]]; then
    # The volume can still be busy the instant verification stops reading it,
    # and a single silent `|| true` detach leaves the image mounted — which
    # makes the NEXT run die with "hdiutil: attach failed - Resource busy".
    # Retry, then say so loudly rather than leaking a mount.
    local detached=false
    for _ in 1 2 3 4 5; do
      if hdiutil detach "$DEV_ENTRY" -force >/dev/null 2>&1; then detached=true; break; fi
      sleep 1
    done
    if [[ "$detached" != true ]]; then
      echo "⚠ Could not detach $DEV_ENTRY — it is still mounted." >&2
      echo "  Run: hdiutil detach $DEV_ENTRY -force" >&2
    fi
  fi
  rm -rf "$MOUNT_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Attaching read-only: $(basename "$DMG")"
ATTACH_INFO="$(hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$MOUNT_DIR")"
# `hdiutil attach` prints, in order:
#     expected   CRC32 $AEC28BB0
#     /dev/disk5       <TAB>GUID_partition_scheme<TAB>
#     /dev/disk5s1     <TAB>Apple_HFS            <TAB>/private/tmp/<mountpoint>
# Apple_HFS is field 2 and the MOUNTPOINT is the last field, so a `$NF ~
# /Apple_HFS/` test never matches and the old `head -1 | cut -f1` fallback
# yielded the literal string "expected" — every detach then failed silently
# and leaked the mount, which is what made later runs die on "Resource busy".
# Match the slice mounted at our own mountpoint (hdiutil reports it under
# /private), and fall back to the whole-disk entry.
MP_BASE="$(basename "$MOUNT_DIR")"
DEV_ENTRY="$(awk -v b="$MP_BASE" '$1 ~ /^\/dev\/disk/ && $NF ~ ("/" b "$") {print $1; exit}' <<<"$ATTACH_INFO")"
[[ -z "$DEV_ENTRY" ]] && DEV_ENTRY="$(awk '$1 ~ /^\/dev\/disk/ {print $1; exit}' <<<"$ATTACH_INFO")"
if [[ ! "$DEV_ENTRY" =~ ^/dev/disk ]]; then
  echo "Error: could not parse a device entry from hdiutil attach output:" >&2
  printf '%s\n' "$ATTACH_INFO" | sed 's/^/    /' >&2
  exit 1
fi

APP_PATHS="$(find "$MOUNT_DIR" -maxdepth 3 -name "Fleuron.app" -type d)"
APP_COUNT="$(grep -c . <<<"$APP_PATHS" || true)"
if [[ "$APP_COUNT" != "1" ]]; then
  echo "Error: expected exactly one Fleuron.app in the DMG, found $APP_COUNT:"
  echo "$APP_PATHS" | sed 's/^/    /'
  exit 1
fi

echo "==> Verifying bundle inside mounted image"
FLEURON_BUILD_COMMIT="$COMMIT" \
  bash "$SCRIPT_DIR/verify-mac-bundle.sh" "$APP_PATHS" "$VERSION"

echo "✓ DMG artifact verified: $(basename "$DMG") (version $VERSION, commit ${COMMIT:0:12})"
