#!/usr/bin/env bash
# Read-only probe of the public `server_schema_version()` RPC.
#
# Used both locally (after `supabase start`, against the local stack) and in
# the reviewed production migration procedure (against the live project).
# It performs a single POST to the public RPC and never writes anything.
#
# Environment:
#   CODEMAP_SYNC_URL        Base URL, e.g. http://127.0.0.1:54331
#                           (defaults to the local stack)
#   CODEMAP_SYNC_ANON_KEY   Public anon key for the project
#                           (defaults to the Supabase local-dev well-known
#                            anon key; correct for an unmodified local stack)
#
# Usage:
#   bash scripts/check-server-schema.sh          # print the version
#   bash scripts/check-server-schema.sh 10       # exit 0 iff version == 10
#
# On failure it prints ONLY the HTTP status — never the response body, which
# can echo request details — and exits 1.
set -euo pipefail
set +x

EXPECTED="${1:-}"

SYNC_URL="${CODEMAP_SYNC_URL:-http://127.0.0.1:54331}"
SYNC_ANON_KEY="${CODEMAP_SYNC_ANON_KEY:-eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0}"

if ! command -v curl >/dev/null 2>&1; then
  echo "✗ curl is required" >&2
  exit 1
fi

url="$(printf '%s' "$SYNC_URL" | sed 's#/$##')/rest/v1/rpc/server_schema_version"

body="$(curl -sS -w '\n%{http_code}' \
  -X POST "$url" \
  -H "apikey: $SYNC_ANON_KEY" \
  -H "Authorization: Bearer $SYNC_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{}')" || {
  echo "✗ HTTP request failed (no response)" >&2
  exit 1
}

status="$(tail -n1 <<<"$body")"
payload="$(sed '$d' <<<"$body")"

if [[ "$status" != "200" ]]; then
  echo "✗ server_schema_version probe failed with HTTP $status" >&2
  exit 1
fi

version="$(tr -d '[:space:]' <<<"$payload")"
if ! [[ "$version" =~ ^[0-9]+$ ]]; then
  echo "✗ server_schema_version returned a non-numeric payload" >&2
  exit 1
fi

echo "server_schema_version: $version"

if [[ -n "$EXPECTED" ]]; then
  if [[ "$version" != "$EXPECTED" ]]; then
    echo "✗ expected schema version $EXPECTED, got $version" >&2
    exit 1
  fi
  echo "✓ schema version matches the certified $EXPECTED"
fi
