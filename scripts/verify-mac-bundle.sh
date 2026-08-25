#!/usr/bin/env bash
# Verify a built Codemap.app is the app we think we built.
#
# History: v0.21.0 shipped a macOS app whose Rust backend was current and whose
# frontend was ten hours stale — dist/ was never rebuilt, and cargo happily
# reused the assets it had already embedded. Every other property of that
# bundle was correct, so every existing check passed. The frontend check below
# is the one that would have caught it.
set -euo pipefail

APP="${1:?usage: verify-mac-bundle.sh <path-to .app> <expected-version> [dist-dir]}"
EXPECTED_VERSION="${2:?usage: verify-mac-bundle.sh <path-to .app> <expected-version> [dist-dir]}"
DIST_DIR="${3:-dist}"

PLIST="$APP/Contents/Info.plist"
[[ -f "$PLIST" ]] || { echo "Error: no Info.plist at $PLIST"; exit 1; }

plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST"; }

NAME="$(plist CFBundleName)"
VERSION="$(plist CFBundleShortVersionString)"
IDENTIFIER="$(plist CFBundleIdentifier)"
# Derive rather than hardcode: the product is "Codemap" but the executable is
# still the crate name, and a rename is exactly when this check must not lie.
BIN="$APP/Contents/MacOS/$(plist CFBundleExecutable)"
[[ -f "$BIN" ]] || { echo "Error: no executable at $BIN"; exit 1; }

if [[ "$IDENTIFIER" != "app.codemap.desktop" ]]; then
  echo "Error: $APP reports identifier $IDENTIFIER, expected app.codemap.desktop."
  exit 1
fi

if [[ "$VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Error: $APP reports version $VERSION, expected $EXPECTED_VERSION."
  echo "       Refusing to claim a good build."
  exit 1
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
if [[ -z "${CODEMAP_SYNC_URL:-}" ]]; then
  echo "⚠ CODEMAP_SYNC_URL is unset — this build will ask each coder for the"
  echo "  server address and key by hand."
elif grep -aqF "$CODEMAP_SYNC_URL" "$BIN"; then
  echo "✓ Compiled-in sync server present in the shipped binary"
else
  echo "Error: CODEMAP_SYNC_URL was set but does not appear in $BIN."
  echo "       Refusing to claim a good build."
  exit 1
fi

echo "✓ Verified $NAME $VERSION"
