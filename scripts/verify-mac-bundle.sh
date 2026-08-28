#!/usr/bin/env bash
# Verify a built Fleuron.app is the app we think we built.
#
# History: v0.21.0 shipped a macOS app whose Rust backend was current and whose
# frontend was ten hours stale — dist/ was never rebuilt, and cargo happily
# reused the assets it had already embedded. Every other property of that
# bundle was correct, so every existing check passed. The frontend check below
# is the one that would have caught it.
#
# v1.2 additions (whole-bundle ad-hoc seal contract):
#   - codesign --deep --strict must verify;
#   - Signature=adhoc and NO TeamIdentifier;
#   - Info.plist bound + Sealed Resources present (rejects v1.1-style
#     `Identifier=generated`, `Info.plist=not bound`, `Sealed Resources=none`);
#   - all five protected-folder purpose strings equal src-tauri/Info.plist;
#   - build commit embedded in the binary matches FLEURON_BUILD_COMMIT
#     (or the literal "development" for local builds);
#   - universal check: both arm64 and x86_64 unless FLEURON_REQUIRE_UNIVERSAL=0;
#   - spctl --assess rejection recorded as EXPECTED evidence for this plan.
set -euo pipefail

APP="${1:?usage: verify-mac-bundle.sh <path-to .app> <expected-version> [dist-dir]}"
EXPECTED_VERSION="${2:?usage: verify-mac-bundle.sh <path-to .app> <expected-version> [dist-dir]}"
DIST_DIR="${3:-dist}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_PLIST="$REPO_ROOT/src-tauri/Info.plist"
REQUIRE_UNIVERSAL="${FLEURON_REQUIRE_UNIVERSAL:-1}"

PLIST="$APP/Contents/Info.plist"
[[ -f "$PLIST" ]] || { echo "Error: no Info.plist at $PLIST"; exit 1; }

plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST"; }

NAME="$(plist CFBundleName)"
VERSION="$(plist CFBundleShortVersionString)"
IDENTIFIER="$(plist CFBundleIdentifier)"
# Derive rather than hardcode: the product is "Fleuron" but the executable is
# still the crate name, and a rename is exactly when this check must not lie.
BIN="$APP/Contents/MacOS/$(plist CFBundleExecutable)"
[[ -f "$BIN" ]] || { echo "Error: no executable at $BIN"; exit 1; }

if [[ "$IDENTIFIER" != "study.fleuron.desktop" ]]; then
  echo "Error: $APP reports identifier $IDENTIFIER, expected study.fleuron.desktop."
  echo "       A generated bundle identifier breaks the provenance contract."
  exit 1
fi

if [[ "$VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Error: $APP reports version $VERSION, expected $EXPECTED_VERSION."
  echo "       Refusing to claim a good build."
  exit 1
fi

# ── Whole-bundle ad-hoc seal ────────────────────────────────────────────────
codesign --verify --deep --strict --verbose=2 "$APP" >/tmp/codesign-verbose.log 2>&1 || {
  echo "Error: codesign --verify --deep --strict failed:"
  cat /tmp/codesign-verbose.log | sed 's/^/    /'
  echo "       Rebuild with signingIdentity \"-\" and infoPlist configured."
  exit 1
}
echo "✓ codesign verifies whole bundle (--deep --strict)"

SIGN_LINE="$(codesign -dv "$APP" 2>&1 | grep -E 'Signature=' || true)"
grep -q 'Signature=adhoc' <<<"$SIGN_LINE" || {
  echo "Error: expected Signature=adhoc, got: ${SIGN_LINE:-<none>}"
  exit 1
}
TEAM_LINE="$(codesign -dv "$APP" 2>&1 | grep -E 'TeamIdentifier=' || true)"
grep -q 'TeamIdentifier=not set' <<<"$TEAM_LINE" || {
  echo "Error: unexpected TeamIdentifier present: '$TEAM_LINE'"
  echo "       Ad-hoc builds must carry no team identity."
  exit 1
}
echo "✓ Signature=adhoc, TeamIdentifier=not set"

CS_INFO="$(codesign -dvv "$APP" 2>&1 || true)"
# macOS 26 codesign prints "Info.plist entries=<n>" where older releases
# printed "Info.plist=bound" for the same bound-in-signature state; require a
# positive count on the new format or the legacy bound marker, so the seal
# check agrees with both codesign generations and still rejects
# "Info.plist=not bound" / absent.
grep -Eq 'Info\.plist=bound|Info\.plist entries=[1-9][0-9]*' <<<"$CS_INFO" || {
  echo "Error: Info.plist is NOT bound into the signature."
  echo "$CS_INFO" | sed 's/^/    /'
  exit 1
}
grep -Eq 'Sealed Resources version=[0-9]+' <<<"$CS_INFO" || {
  echo "Error: Sealed Resources missing from code signature."
  exit 1
}
echo "✓ Info.plist bound; sealed resources present"

# ── Purpose strings match the source plist exactly ──────────────────────────
PURPOSE_KEYS=(
  NSDocumentsFolderUsageDescription
  NSDesktopFolderUsageDescription
  NSDownloadsFolderUsageDescription
  NSNetworkVolumesUsageDescription
  NSRemovableVolumesUsageDescription
)
[[ -f "$SOURCE_PLIST" ]] || { echo "Error: source plist missing at $SOURCE_PLIST"; exit 1; }
for key in "${PURPOSE_KEYS[@]}"; do
  want="$(/usr/libexec/PlistBuddy -c "Print :$key" "$SOURCE_PLIST")"
  got="$(plist "$key" 2>/dev/null || true)"
  if [[ "$got" != "$want" ]]; then
    echo "Error: purpose string drift for $key."
    echo "  expected: $want"
    echo "  bundled:  ${got:-<missing>}"
    echo "  src-tauri/Info.plist and the built bundle must agree."
    exit 1
  fi
done
echo "✓ All five protected-folder purpose strings match source"

# Unused-capability tripwire: none of these may EVER appear in the plist.
for forbidden_key in NSCameraUsageDescription NSMicrophoneUsageDescription \
                     NSLocationWhenInUseUsageDescription NSAppleEventsUsageDescription \
                     NSAccessibilityUsageDescription NSFullDiskAccessUsageDescription; do
  if grep -q "$forbidden_key" "$PLIST"; then
    echo "Error: forbidden permission key present: $forbidden_key"
    exit 1
  fi
done
echo "✓ No unused/hardware capability keys declared"

# ── Build commit provenance ──────────────────────────────────────────────────
BUILD_COMMIT="${FLEURON_BUILD_COMMIT:-development}"
grep -aqF "$BUILD_COMMIT" "$BIN" || {
  echo "Error: build commit '$BUILD_COMMIT' not found embedded in $BIN."
  echo "       Candidate/release builds set FLEURON_BUILD_COMMIT at compile time."
  exit 1
}
echo "✓ Build commit ($BUILD_COMMIT) embedded in binary"

# ── Architectures ────────────────────────────────────────────────────────────
ARCHS_OUTPUT="$(lipo -archs "$BIN")"
has_arm=false; has_x86=false
if grep -qw arm64 <<<"$ARCHS_OUTPUT"; then has_arm=true; fi
if grep -qw x86_64 <<<"$ARCHS_OUTPUT"; then has_x86=true; fi
if [[ "$REQUIRE_UNIVERSAL" == "1" ]]; then
  if [[ "$has_arm" == false || "$has_x86" == false ]]; then
    echo "Error: universal release requires arm64+x86_64; lipo reports: $ARCHS_OUTPUT"
    exit 1
  fi
  echo "✓ Universal executable contains both arm64 and x86_64"
else
  echo "⚠ Universal check skipped (FLEURON_REQUIRE_UNIVERSAL=0); archs: $ARCHS_OUTPUT"
fi

# ── The frontend bundle ─────────────────────────────────────────────────────
# Vite content-hashes its filenames, so the name IS the fingerprint. If the
# name in dist/ is not embedded in the binary, the app is showing a different
# UI than the one just built.
shopt -s nullglob
assets=("$DIST_DIR/assets/"index-*.js "$DIST_DIR/assets/"index-*.css)
shopt -u nullglob

if [[ ${#assets[@]} -eq 0 ]]; then
  echo "Error: no index-*.js/.css in $DIST_DIR/assets — run 'npm run build' first."
  exit 1
fi

js_count=$(ls "$DIST_DIR/assets/"index-*.js 2>/dev/null | wc -l | tr -d ' ')
if [[ "$js_count" -ne 1 ]]; then
  echo "Error: expected exactly 1 index-*.js in $DIST_DIR/assets, found $js_count."
  echo "       A stale bundle sitting beside a fresh one is its own bug."
  ls -la "$DIST_DIR/assets/"
  exit 1
fi

for asset in "${assets[@]}"; do
  name="$(basename "$asset")"
  # -a matters: without it grep exits non-zero on a binary even when it matches,
  # so this check would fail every good build. Verified, not assumed.
  if ! grep -aqF "$name" "$BIN"; then
    echo "Error: the app bundle does not contain the frontend in $DIST_DIR/."
    echo "       $DIST_DIR/assets has: $name"
    echo "       ...but the binary embeds a different bundle:"
    grep -a -o -E 'index-[A-Za-z0-9_-]{6,10}\.(js|css)' "$BIN" | sort -u | sed 's/^/         /'
    echo "       Run 'npm run build' and rebuild."
    echo "       This is the v0.21.0 stale-frontend defect."
    exit 1
  fi
done
echo "✓ Shipped binary embeds the current frontend ($(basename "${assets[0]}"))"

# ── The compiled-in sync server ─────────────────────────────────────────────
if [[ -z "${FLEURON_SYNC_URL:-}" ]]; then
  echo "⚠ FLEURON_SYNC_URL is unset — this build will ask each coder for the"
  echo "  server address and key by hand."
elif grep -aqF "$FLEURON_SYNC_URL" "$BIN"; then
  echo "✓ Compiled-in sync server present in the shipped binary"
else
  echo "Error: FLEURON_SYNC_URL was set but does not appear in $BIN."
  echo "       Refusing to claim a good build."
  exit 1
fi

# ── Gatekeeper assessment (expected rejection, recorded as evidence) ────────
spctl_output="$(spctl --assess --type execute "$APP" 2>&1 || true)"
echo "ℹ spctl assessment for the record (ad-hoc builds are expected to be REJECTED):"
echo "$spctl_output" | sed 's/^/    /'

echo "✓ Verified $NAME $VERSION"
