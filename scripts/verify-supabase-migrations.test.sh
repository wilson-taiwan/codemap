#!/usr/bin/env bash
# Self-check for scripts/verify-supabase-migrations.sh (negative fixtures).
#
# Builds a throwaway copy of the migration subtree under `mktemp -d` and proves
# the verifier (a) passes on a clean copy, (b) rejects an out-of-order and a
# malformed migration name, and (c) rejects a release workflow that
# reintroduces `supabase db push`. It never modifies any real repository file.
#
# Also validates both CI workflow YAML files with Ruby when available.
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERIFIER="$ROOT/scripts/verify-supabase-migrations.sh"

PASS=0
FAIL=0

fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

mkdir -p "$fixture/supabase/migrations" "$fixture/supabase/history" "$fixture/.github/workflows"

cp "$ROOT"/supabase/migrations/*.sql "$fixture/supabase/migrations/"
cp "$ROOT"/supabase/schema.sql "$fixture/supabase/"
cp "$ROOT"/supabase/config.toml "$fixture/supabase/"
cp "$ROOT"/supabase/history/*.sql "$fixture/supabase/history/"
cp "$ROOT"/supabase/migrate-002-highlight-spans.sql "$fixture/supabase/" 2>/dev/null || true

cat > "$fixture/.github/workflows/release.yml" <<'YAML'
name: Release
on:
  push:
    tags:
      - "v*"
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
YAML

check_case() {
  local name="$1"
  local expect="$2"
  shift 2
  local out
  if out="$(FLEURON_SRC_ROOT="$fixture" "$VERIFIER" 2>&1)"; then
    if [[ "$expect" == "pass" ]]; then
      echo "  ✓ $name"
      PASS=$((PASS + 1))
    else
      echo "  ✗ $name: verifier passed but should have failed"
      FAIL=$((FAIL + 1))
    fi
  else
    if [[ "$expect" == "fail" ]]; then
      echo "  ✓ $name (rejected)"
      PASS=$((PASS + 1))
    else
      echo "  ✗ $name: verifier failed unexpectedly:"
      echo "    $(echo "$out" | tail -1)"
      FAIL=$((FAIL + 1))
    fi
  fi
}

echo "── positive control (clean fixture) …"
check_case "clean fixture passes" pass

echo "── out-of-order migration …"
cp "$fixture/supabase/migrations/20260826000000_entitlements_and_sync_gate.sql" \
   "$fixture/supabase/migrations/20260826000000_duplicate_timestamp.sql"
check_case "out-of-order migration rejected" fail
rm "$fixture/supabase/migrations/20260826000000_duplicate_timestamp.sql"

echo "── malformed migration filename …"
cp "$fixture/supabase/migrations/20260823000000_v1_certified_baseline.sql" \
   "$fixture/supabase/migrations/not-a-migration.sql"
check_case "malformed filename rejected" fail
rm "$fixture/supabase/migrations/not-a-migration.sql"

echo "── release workflow with supabase db push …"
cat > "$fixture/.github/workflows/release.yml" <<'YAML'
name: Release
on:
  push:
    tags:
      - "v*"
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - run: supabase db push --db-url "$SUPABASE_DB_URL"
YAML
check_case "release-workflow db push rejected" fail

echo "── post-schema-10 certification mutation …"
cat > "$fixture/supabase/migrations/20260905000000_illegal_certification.sql" <<'SQL'
begin;
update public.server_meta set schema_version = 11;
commit;
SQL
check_case "post-schema-10 certification write rejected" fail
rm "$fixture/supabase/migrations/20260905000000_illegal_certification.sql"

echo "── extra table grant in null-spans migration …"
echo "grant select on table public.sync_devices to authenticated;" >> "$fixture/supabase/migrations/20260904000000_sync_v2_allow_null_spans_and_grant_heads.sql"
check_case "extra table grant in null-spans migration rejected" fail
cp "$ROOT/supabase/migrations/20260904000000_sync_v2_allow_null_spans_and_grant_heads.sql" "$fixture/supabase/migrations/"

if ! command -v ruby >/dev/null 2>&1; then
  echo "  · ruby unavailable — skipping YAML workflow validation"
else
  echo "── YAML workflow syntax …"
  for wf in test.yml release.yml; do
    if ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0))' "$ROOT/.github/workflows/$wf"; then
      echo "  ✓ $wf is valid YAML"
      PASS=$((PASS + 1))
    else
      echo "  ✗ $wf is not valid YAML"
      FAIL=$((FAIL + 1))
    fi
  done
fi

echo
if [[ "$FAIL" -gt 0 ]]; then
  echo "✗ verify-supabase-migrations self-check: $FAIL failed, $PASS passed"
  exit 1
fi
echo "✓ verify-supabase-migrations self-check: all $PASS checks passed"
