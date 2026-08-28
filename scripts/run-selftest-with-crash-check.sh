#!/usr/bin/env bash
set -euo pipefail

# run-selftest-with-crash-check.sh: Runs selftest and verifies zero crash reports were produced.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

START_TIME=$(date +%s)

echo "==> Starting Fleuron Selftest with Crash Verification..."
node "$SCRIPT_DIR/run-selftest.mjs" "$@"

echo "==> Verifying zero crashes occurred during test..."
"$SCRIPT_DIR/check-no-crashes.sh" "$START_TIME"

echo "==> Selftest and Crash Verification PASSED successfully."
