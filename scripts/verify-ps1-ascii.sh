#!/usr/bin/env bash
# Reject non-ASCII PowerShell source before Windows PowerShell 5.1 decodes a
# BOM-less UTF-8 byte sequence as cp1252 and changes its parser meaning.
#
# Why this exists: a non-ASCII glyph in a .ps1 file can become a quote-like
# character under the legacy decoder, causing syntax errors far from the byte
# that caused them. Keeping every PowerShell source file ASCII-only makes the
# same source safe for both Windows PowerShell 5.1 and pwsh.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

failed=0
while IFS= read -r -d '' ps1; do
  # POSIX character classes express the full C-locale byte range on both
  # macOS BSD grep and GNU grep. Some BSD grep versions do not interpret
  # \x00-\x7F inside a bracket expression as hexadecimal bytes.
  if LC_ALL=C grep -nH '[^[:cntrl:][:print:]]' "$ps1"; then
    failed=1
  fi
done < <(find . \( -path './.git' -o -path './node_modules' -o -path './src-tauri/target' \) -prune -o -type f -name '*.ps1' -print0)

if [ "$failed" -ne 0 ]; then
  echo "Error: every .ps1 file must be ASCII-only for Windows PowerShell 5.1."
  exit 1
fi

echo "Every .ps1 file in the repository is ASCII-only."
