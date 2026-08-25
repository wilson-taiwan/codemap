#!/usr/bin/env bash
set -euo pipefail

# test-check-no-crashes.sh: Verifies check-no-crashes.sh and summarize-macos-crash.py
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Testing summarize-macos-crash.py on synthetic JSON .ips crash report..."
SAMPLE_IPS="$TEMP_DIR/Codemap-2026-08-22-120000.ips"
cat << 'EOF' > "$SAMPLE_IPS"
{
  "app_name": "Codemap",
  "bundleID": "app.codemap.desktop",
  "app_version": "1.0.0",
  "os_version": "macOS 15.0",
  "captureTime": "2026-08-22 12:00:00 -0700",
  "exception": {
    "type": "EXC_BAD_ACCESS",
    "signal": "SIGSEGV"
  },
  "faultingThread": 0,
  "threads": [
    {
      "frames": [
        { "symbol": "qualitative_coding_app_lib::run", "imageIndex": 0 },
        { "symbol": "main", "imageIndex": 0 }
      ]
    }
  ]
}
EOF

python3 "$SCRIPT_DIR/summarize-macos-crash.py" "$SAMPLE_IPS" > /dev/null

echo "Testing check-no-crashes.sh with clean environment (future timestamp)..."
FUTURE_TIME=$(($(date +%s) + 3600))
"$SCRIPT_DIR/check-no-crashes.sh" "$FUTURE_TIME" > /dev/null

echo "✓ test-check-no-crashes: All tests passed."
