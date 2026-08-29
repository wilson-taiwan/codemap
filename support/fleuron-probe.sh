#!/usr/bin/env bash
# Fleuron Read-Only Diagnostic Probe (macOS)
#
# Gathers environment and install diagnostics for troubleshooting when the app
# fails to launch. This probe is strictly READ-ONLY: it never modifies files,
# installs software, or collects transcript text, participant labels, or code names.

set -euo pipefail

PROBE_VERSION="1.0.0"
output_file=""

usage() {
  cat << 'EOF'
Fleuron Diagnostic Probe (macOS) - Read-only environment & install inspection

Usage:
  fleuron-probe.sh [--output <path>]
  fleuron-probe.sh --help

Options:
  --output <path>, -o <path>  Write report to a file instead of stdout only
  --help, -h                  Show this help text
EOF
}

main() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --output|-o)
        [ "$#" -ge 2 ] || { echo "error: --output requires a file path" >&2; exit 2; }
        output_file="$2"
        shift 2
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        echo "error: unknown argument: $1" >&2
        usage >&2
        exit 2
        ;;
    esac
  done

  local report
  report=$(generate_report)

  if [ -n "$output_file" ]; then
    printf '%s\n' "$report" > "$output_file"
    echo "Diagnostic report saved to $output_file"
  else
    printf '%s\n' "$report"
  fi
}

redact_panic_payload() {
  local raw="$1"
  # 1. Replace home directory if present
  if [ -n "${HOME:-}" ]; then
    raw="${raw//$HOME/<home>}"
  fi
  # 2. Collapse non-whitelisted characters to space
  local cleaned
  cleaned=$(printf '%s' "$raw" | LC_ALL=C tr -c 'a-zA-Z0-9 ._:/()<\->' ' ' | tr -s ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  local char_len
  char_len=${#cleaned}
  if [ "$char_len" -le 120 ]; then
    printf '[payload truncated for privacy] %s' "$cleaned"
  else
    local truncated
    truncated=$(printf '%s' "$cleaned" | cut -c 1-120)
    local withheld=$((char_len - 120))
    printf '[payload truncated for privacy] %s ...(+%d chars withheld)' "$truncated" "$withheld"
  fi
}

generate_report() {
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  echo "=== Fleuron Diagnostic Probe Report (macOS) ==="
  echo "Generated: $now"
  echo "Probe version: $PROBE_VERSION"
  echo "Privacy guarantee: This probe is read-only and collects no transcript text, participant labels, or code names."
  echo ""

  echo "--- System ---"
  echo "OS: macOS"
  if command -v sw_vers >/dev/null 2>&1; then
    echo "Product: $(sw_vers -productName 2>/dev/null || echo 'macOS')"
    echo "Version: $(sw_vers -productVersion 2>/dev/null || echo 'unknown')"
    echo "Build: $(sw_vers -buildVersion 2>/dev/null || echo 'unknown')"
  fi
  echo "Architecture: $(uname -m 2>/dev/null || echo 'unknown')"
  echo ""

  echo "--- Application Install ---"
  local found_app=0
  for app_path in "/Applications/Fleuron.app" "$HOME/Applications/Fleuron.app"; do
    if [ -d "$app_path" ]; then
      found_app=1
      echo "Bundle found: <home>${app_path#$HOME}"
      if [ -f "$app_path/Contents/Info.plist" ] && command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
        local ver
        ver=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$app_path/Contents/Info.plist" 2>/dev/null || echo "unknown")
        echo "Bundle version: $ver"
      fi
      local bin="$app_path/Contents/MacOS/Fleuron"
      if [ -f "$bin" ]; then
        echo "Binary present: true (executable)"
      elif [ -d "$bin" ]; then
        echo "Binary present: FALSE (detected poisoned nested directory: $bin is a folder)"
      else
        echo "Binary present: false (missing)"
      fi
    fi
  done
  if [ "$found_app" -eq 0 ]; then
    echo "Fleuron.app not found in /Applications or ~/Applications"
  fi
  echo ""

  echo "--- Library Directory ---"
  local lib_dir="$HOME/Fleuron"
  if [ -d "$lib_dir" ]; then
    echo "Library: <library> (exists)"
    local count
    count=$(find "$lib_dir" -maxdepth 2 \( -name '*.fleuron' -o -name '*.codemap' -o -name '*.qcproj' -o -name 'project.db' \) 2>/dev/null | wc -l | tr -d ' ')
    echo "Project count: $count"
  else
    echo "Library: <library> (absent)"
  fi
  echo ""

  echo "--- Crash Logs ---"
  local crash_file="$HOME/Library/Application Support/study.fleuron.desktop/crashes/crash.log"
  if [ -f "$crash_file" ]; then
    local size
    size=$(wc -c < "$crash_file" 2>/dev/null | tr -d ' ')
    echo "Crash log present: true ($size bytes)"
    echo "Recent records (redacted):"
    # Read crash records and redact payloads
    awk '
      /--- CRASH RECORD ---/ { in_rec=1; rec=""; next }
      /--- END RECORD ---/ { in_rec=0; print rec; next }
      in_rec { rec = rec "\n" $0 }
    ' "$crash_file" | while IFS= read -r line; do
      if [[ "$line" =~ ^Message:[[:space:]]*(.*)$ ]]; then
        local raw_msg="${BASH_REMATCH[1]}"
        local redacted
        redacted=$(redact_panic_payload "$raw_msg")
        echo "Message: $redacted"
      elif [[ "$line" =~ ^(Timestamp:|Version:|OS:|Thread:|Location:) ]]; then
        echo "$line"
      fi
    done
  else
    echo "Crash log present: false (clean)"
  fi

  echo ""
  echo "--- System Crash Dumps ---"
  local dumps_dir="$HOME/Library/Logs/DiagnosticReports"
  if [ -d "$dumps_dir" ]; then
    local dump_count
    dump_count=$(find "$dumps_dir" -maxdepth 1 -name '*Fleuron*' -o -name '*Codemap*' 2>/dev/null | wc -l | tr -d ' ')
    echo "System crash reports matching Fleuron: $dump_count"
  else
    echo "System crash reports directory: unavailable"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
