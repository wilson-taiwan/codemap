#!/usr/bin/env bash
set -euo pipefail

# check-no-crashes.sh: Verifies no crash reports were generated during the run.
# Usage: check-no-crashes.sh [START_TIMESTAMP_SECONDS]

START_TIME="${1:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRASH_FOUND=0

echo "[crash-check] Scanning system diagnostic reports and internal crash logs..."

# 1. macOS DiagnosticReports
if [[ "$(uname -s)" == "Darwin" ]]; then
  REPORTS_DIR="$HOME/Library/Logs/DiagnosticReports"
  if [[ -d "$REPORTS_DIR" ]]; then
    # Look for Fleuron*.ips or Fleuron*.crash modified after START_TIME
    while IFS= read -r report_file; do
      if [[ -n "$report_file" ]]; then
        mod_time=$(stat -f "%m" "$report_file" 2>/dev/null || stat -c "%Y" "$report_file" 2>/dev/null || echo 0)
        if (( mod_time >= START_TIME )); then
          echo "❌ [crash-check] Found macOS system crash report: $report_file"
          python3 "$SCRIPT_DIR/summarize-macos-crash.py" "$report_file" || true
          CRASH_FOUND=1
        fi
      fi
    done < <(find "$REPORTS_DIR" -maxdepth 2 -type f \( -name "Fleuron*.ips" -o -name "Fleuron*.crash" \) 2>/dev/null || true)
  fi
fi

# 2. Linux coredump / /var/crash
if [[ "$(uname -s)" == "Linux" ]]; then
  if command -v coredumpctl &>/dev/null; then
    if coredumpctl list --since="@$START_TIME" 2>/dev/null | grep -i "Fleuron" &>/dev/null; then
      echo "❌ [crash-check] Linux coredump recorded for Fleuron since start timestamp."
      CRASH_FOUND=1
    fi
  fi
fi

# 3. Fleuron internal crash log check
# Search typical AppData locations for crashes/crash.log
APP_DATA_CRASH_DIRS=(
  "$HOME/Library/Application Support/study.fleuron.desktop/crashes"
  "$HOME/Library/Application Support/qualitative-coding-app/crashes"
  "$HOME/.local/share/study.fleuron.desktop/crashes"
  "$HOME/.local/share/qualitative-coding-app/crashes"
)

for cdir in "${APP_DATA_CRASH_DIRS[@]}"; do
  log_file="$cdir/crash.log"
  if [[ -f "$log_file" && -s "$log_file" ]]; then
    mod_time=$(stat -f "%m" "$log_file" 2>/dev/null || stat -c "%Y" "$log_file" 2>/dev/null || echo 0)
    if (( mod_time >= START_TIME )); then
      echo "❌ [crash-check] Internal crash log was updated during test: $log_file"
      CRASH_FOUND=1
    fi
  fi
done

if (( CRASH_FOUND == 0 )); then
  echo "✓ [crash-check] No crash reports detected."
  exit 0
else
  echo "❌ [crash-check] Failure: Crashes detected during execution."
  exit 1
fi
