#!/usr/bin/env bash
# Fleuron macOS QA Runner.
#
# Verifies the release DMG and its bundled app without installing anything or
# attempting to bypass Gatekeeper. It is intentionally dependency-free on
# supported macOS hosts: hdiutil, codesign, and PlistBuddy ship with macOS.

set -o pipefail

RUNNER_VERSION="1.0.0"
SCRIPT_DIR="$(cd "$(dirname "$BASH_SOURCE")" && pwd)"
candidate=""
expected_version=""
output_directory=""
mounted=0
mount_directory=""
failure_count=0

usage() {
  printf '%s\n' "Usage: $(basename "$0") --candidate /path/Fleuron_X.Y.Z_universal.dmg [--expected-version X.Y.Z] [--output-directory path]"
  printf '%s\n' ""
  printf '%s\n' "The packaged release runner reads release.json and pins the matching version."
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 2
}

record() {
  status="$1"
  name="$2"
  details="$3"
  printf '| %s | %s | %s |\n' "$status" "$name" "$details" >> "$summary_path"
  printf '[%s] %s - %s\n' "$status" "$name" "$details"
  if [ "$status" = "FAIL" ]; then
    failure_count=$((failure_count + 1))
  fi
}

cleanup() {
  if [ "$mounted" -eq 1 ]; then
    hdiutil detach "$mount_directory" -quiet >/dev/null 2>&1 || true
  fi
  if [ -n "$mount_directory" ]; then
    rmdir "$mount_directory" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --candidate)
      [ "$#" -ge 2 ] || die "--candidate requires a path"
      candidate="$2"
      shift 2
      ;;
    --expected-version)
      [ "$#" -ge 2 ] || die "--expected-version requires X.Y.Z"
      expected_version="$2"
      shift 2
      ;;
    --output-directory)
      [ "$#" -ge 2 ] || die "--output-directory requires a path"
      output_directory="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$candidate" ] || die "--candidate is required"
[ -f "$candidate" ] || die "candidate DMG not found: $candidate"

manifest_path="$SCRIPT_DIR/release.json"
manifest_version=""
manifest_platform=""
if [ -f "$manifest_path" ]; then
  manifest_version="$(LC_ALL=C sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)"[[:space:]]*,?[[:space:]]*$/\1/p' "$manifest_path" | head -n 1)"
  manifest_platform="$(LC_ALL=C sed -nE 's/^[[:space:]]*"platform"[[:space:]]*:[[:space:]]*"([^"]+)"[[:space:]]*,?[[:space:]]*$/\1/p' "$manifest_path" | head -n 1)"
  [ -n "$manifest_version" ] || die "release.json has no valid semantic version"
  [ -z "$manifest_platform" ] || [ "$manifest_platform" = "macos" ] || die "release.json platform must be macos"
fi

candidate_name="$(basename "$candidate")"
candidate_version="$(printf '%s\n' "$candidate_name" | sed -nE 's/^Fleuron_([0-9]+\.[0-9]+\.[0-9]+)_universal\.dmg$/\1/p')"

if [ -n "$expected_version" ] && [ -n "$manifest_version" ] && [ "$expected_version" != "$manifest_version" ]; then
  die "--expected-version conflicts with packaged runner version $manifest_version"
fi
if [ -z "$expected_version" ]; then
  if [ -n "$manifest_version" ]; then
    expected_version="$manifest_version"
  else
    expected_version="$candidate_version"
  fi
fi

[[ "$expected_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "cannot determine expected version; use --expected-version X.Y.Z or a canonical Fleuron_X.Y.Z_universal.dmg"
if [ -n "$candidate_version" ] && [ "$candidate_version" != "$expected_version" ]; then
  die "candidate $candidate_name is version $candidate_version but this runner expects $expected_version"
fi

if [ -z "$output_directory" ]; then
  output_directory="$PWD/fleuron-qa-evidence"
fi
if [ -e "$output_directory" ]; then
  backup_directory="$output_directory.$(date +%Y%m%d-%H%M%S).bak"
  mv "$output_directory" "$backup_directory" || die "cannot rotate existing output directory"
fi
mkdir -p "$output_directory/raw" || die "cannot create output directory"
summary_path="$output_directory/SUMMARY.md"
raw_directory="$output_directory/raw"

printf '# Fleuron macOS QA evidence\n\n' > "$summary_path"
printf -- '- **Runner version:** %s\n' "$RUNNER_VERSION" >> "$summary_path"
printf -- '- **Expected release:** %s\n' "$expected_version" >> "$summary_path"
printf -- '- **Candidate:** %s\n\n' "$candidate_name" >> "$summary_path"
printf '## Automated checks\n\n| Status | Check | Details |\n| --- | --- | --- |\n' >> "$summary_path"

if hdiutil verify "$candidate" > "$raw_directory/dmg-verify.log" 2>&1; then
  record "PASS" "dmg_integrity" "hdiutil verified the candidate DMG."
  dmg_verified=1
else
  record "FAIL" "dmg_integrity" "hdiutil could not verify the candidate DMG; see raw/dmg-verify.log."
  dmg_verified=0
fi

if [ "$dmg_verified" -eq 1 ]; then
  tmp_root="$TMPDIR"
  if [ -z "$tmp_root" ]; then
    tmp_root="/tmp"
  fi
  mount_directory="$(mktemp -d "$tmp_root/fleuron-qa.XXXXXX")" || die "cannot create temporary mount directory"

  if hdiutil attach "$candidate" -readonly -nobrowse -mountpoint "$mount_directory" > "$raw_directory/dmg-attach.log" 2>&1; then
    mounted=1
    record "PASS" "dmg_mount" "Mounted the candidate DMG read-only."
  else
    record "FAIL" "dmg_mount" "Could not mount the candidate DMG; see raw/dmg-attach.log."
  fi

  if [ "$mounted" -eq 1 ]; then
    app_bundle="$mount_directory/Fleuron.app"
    info_plist="$app_bundle/Contents/Info.plist"
    app_binary="$app_bundle/Contents/MacOS/Fleuron"

    if [ -d "$app_bundle" ]; then
      record "PASS" "app_bundle_present" "Fleuron.app is present in the mounted DMG."
    else
      record "FAIL" "app_bundle_present" "Fleuron.app is missing from the mounted DMG."
    fi

    if [ -f "$info_plist" ]; then
      bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist" 2> "$raw_directory/bundle-version.err")"
      if [ "$bundle_version" = "$expected_version" ]; then
        record "PASS" "bundle_version" "CFBundleShortVersionString is $bundle_version."
      else
        record "FAIL" "bundle_version" "Expected $expected_version, found $bundle_version."
      fi
    else
      record "FAIL" "bundle_version" "Info.plist is missing from Fleuron.app."
    fi

    if [ -d "$app_bundle" ]; then
      if codesign --verify --deep --strict --verbose=2 "$app_bundle" > "$raw_directory/codesign-verify.log" 2>&1; then
        record "PASS" "bundle_signature" "codesign verified the complete app bundle."
      else
        record "FAIL" "bundle_signature" "codesign rejected the app bundle; see raw/codesign-verify.log."
      fi
    else
      record "SKIP" "bundle_signature" "Skipped because Fleuron.app is missing."
    fi

    if [ -x "$app_binary" ]; then
      if "$app_binary" --selftest > "$raw_directory/selftest.log" 2>&1; then
        record "PASS" "packaged_app_selftest" "The packaged app exited successfully from --selftest."
      else
        record "FAIL" "packaged_app_selftest" "The packaged app failed --selftest; see raw/selftest.log."
      fi
    else
      record "FAIL" "packaged_app_selftest" "Fleuron executable is missing or not executable."
    fi

    if hdiutil detach "$mount_directory" -quiet > "$raw_directory/dmg-detach.log" 2>&1; then
      mounted=0
      record "PASS" "dmg_detach" "Detached the candidate DMG."
    else
      record "FAIL" "dmg_detach" "Could not detach the candidate DMG; see raw/dmg-detach.log."
    fi
  fi
fi

printf '\n## Result\n\n' >> "$summary_path"
if [ "$failure_count" -eq 0 ]; then
  printf 'PASS - %s automated checks completed successfully.\n' "$RUNNER_VERSION" >> "$summary_path"
  printf 'Fleuron macOS QA runner passed. Evidence: %s\n' "$output_directory"
  exit 0
fi

printf 'FAIL - %s automated check(s) failed. Inspect raw logs before approving this release.\n' "$failure_count" >> "$summary_path"
printf 'Fleuron macOS QA runner failed. Evidence: %s\n' "$output_directory" >&2
exit 1
