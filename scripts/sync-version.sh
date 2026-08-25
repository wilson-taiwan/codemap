#!/usr/bin/env bash
# Sync app version across package.json, package-lock.json, tauri.conf.json,
# Cargo.toml and Cargo.lock.
#
# The two lockfiles are easy to forget because nothing reads their version at
# runtime — but the tools rewrite their own entry on the next install or build,
# which dirties the tree mid-release. Both had been missed on every release so
# far: Cargo.lock trailed by a release or two, and package-lock.json never moved
# off 0.1.0 at all. Sync them here rather than discovering it during a build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARG="${1:-}"

if [[ "$ARG" == "--check" ]]; then
  PKG=$(node -p "require('$ROOT/package.json').version")
  PKG_LOCK=$(node -p "require('$ROOT/package-lock.json').version")
  PKG_LOCK_SELF=$(node -p "require('$ROOT/package-lock.json').packages[''].version")
  TAURI=$(node -p "require('$ROOT/src-tauri/tauri.conf.json').version")
  CARGO=$(grep '^version = ' "$ROOT/src-tauri/Cargo.toml" | head -1 | sed 's/version = "\(.*\)"/\1/')
  CARGO_LOCK=$(grep -A1 '^name = "qualitative-coding-app"' "$ROOT/src-tauri/Cargo.lock" \
               | grep '^version = ' | head -1 | sed 's/version = "\(.*\)"/\1/')

  FAILED=0
  for pair in "package-lock.json:$PKG_LOCK" "package-lock(self):$PKG_LOCK_SELF" \
              "tauri.conf.json:$TAURI" "Cargo.toml:$CARGO" "Cargo.lock:$CARGO_LOCK"; do
    NAME="${pair%%:*}"
    VALUE="${pair##*:}"
    if [[ "$VALUE" != "$PKG" ]]; then
      echo "Error: $NAME is $VALUE, expected $PKG"
      FAILED=1
    fi
  done

  if [[ "$FAILED" == "1" ]]; then
    echo "Version mismatch across manifests. Run: bash scripts/sync-version.sh $PKG"
    exit 1
  fi
  echo "✓ All manifest versions match: $PKG"
  exit 0
fi

VERSION="$ARG"

if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require('$ROOT/package.json').version")"
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: version must be semver (e.g. 0.1.2), got: $VERSION"
  exit 1
fi

node -e "
const fs = require('fs');
const root = process.argv[1];
const version = process.argv[2];

const pkgPath = root + '/package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// npm stores the root package's version twice, and rewrites both on install.
const lockJsonPath = root + '/package-lock.json';
const lockJson = JSON.parse(fs.readFileSync(lockJsonPath, 'utf8'));
lockJson.version = version;
if (lockJson.packages && lockJson.packages['']) {
  lockJson.packages[''].version = version;
}
fs.writeFileSync(lockJsonPath, JSON.stringify(lockJson, null, 2) + '\n');

const tauriPath = root + '/src-tauri/tauri.conf.json';
const tauri = JSON.parse(fs.readFileSync(tauriPath, 'utf8'));
tauri.version = version;
fs.writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + '\n');

const cargoPath = root + '/src-tauri/Cargo.toml';
const cargo = fs.readFileSync(cargoPath, 'utf8');
// Assert the line exists rather than that the content changed — re-running the
// script at the version it already set is a no-op, not a failure.
if (!/^version = \".*\"/m.test(cargo)) {
  throw new Error('Cargo.toml version line not found');
}
fs.writeFileSync(
  cargoPath,
  cargo.replace(/^version = \".*\"/m, 'version = \"' + version + '\"'),
);

// Only this crate's own entry — every other [[package]] is a dependency and
// must keep the version cargo resolved for it.
const lockPath = root + '/src-tauri/Cargo.lock';
const crate = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name;
const lock = fs.readFileSync(lockPath, 'utf8');
const ownEntry = new RegExp('(name = \"' + crate + '\"\\\\nversion = )\"[^\"]*\"');
if (!ownEntry.test(lock)) {
  throw new Error('Cargo.lock entry for ' + crate + ' not found');
}
fs.writeFileSync(lockPath, lock.replace(ownEntry, '\$1\"' + version + '\"'));
" "$ROOT" "$VERSION"

echo "Synced version $VERSION across manifests (incl. Cargo.lock)."
