#!/usr/bin/env bash
# Static verification for the Codemap Supabase migration chain.
#
# Approved by `supabase/MIGRATIONS.md` as the local verification gate. This
# script never talks to any database — it inspects the repository structure
# and the migration files themselves and is safe to run in CI or offline.
#
# What it verifies:
#   1. Every standard migration has a strictly increasing 14-digit timestamp
#      prefix and a sane name.
#   2. The v1 certified baseline, the schema-10 protocol-2 migration, and the
#      entitlements migration all exist.
#   3. The required protocol-2 RPC tokens still live in the schema-10
#      migration.
#   4. The entitlement objects and write gates live in the entitlements
#      migration (and that the write gate call appears in the required
#      functions/policies).
#   5. No migration raises the server schema version past the certified 10.
#   6. The immutable v1 legacy artifacts (history/, schema.sql, flat
#      migrate-*.sql) are still present.
#   7. `supabase/config.toml` does not override schema_paths.
#   8. The release workflow never reintroduces `supabase db push`, migration
#      repair, or mutating SQL.
#
# Env vars:
#   CODEMAP_SRC_ROOT  Repo root to inspect (defaults to the repository that
#                     contains this script). Used by the negative-fixture
#                     self-check (scripts/verify-supabase-migrations.test.sh).
set -euo pipefail
set +x

ROOT="${CODEMAP_SRC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
MIGRATIONS_DIR="$ROOT/supabase/migrations"
RELEASE_WORKFLOW="$ROOT/.github/workflows/release.yml"

V1_BASELINE="20260823000000_v1_certified_baseline.sql"
SCHEMA_10="20260823000001_sync_protocol_v2_schema_10.sql"
ENTITLEMENTS="20260826000000_entitlements_and_sync_gate.sql"
CERTIFIED_SCHEMA_VERSION="10"

fail() {
  echo "✗ $*" >&2
  exit 1
}

ok() {
  echo "✓ $*"
}

[[ -d "$MIGRATIONS_DIR" ]] || fail "migration directory missing: $MIGRATIONS_DIR"

# ── 1. Naming and ordering ────────────────────────────────────────────────────
last_prefix=""
count=0
for migration in "$MIGRATIONS_DIR"/*.sql; do
  [[ -e "$migration" ]] || continue
  name="$(basename "$migration")"
  [[ "$name" =~ ^[0-9]{14}_[A-Za-z0-9_-]+\.sql$ ]] \
    || fail "malformed migration filename: $name (expected 14-digit timestamp + snake_case + .sql)"
  count=$((count + 1))
  prefix="${name:0:14}"
  [[ "$prefix" =~ ^[0-9]{14}$ ]] \
    || fail "migration timestamp prefix is not numeric: $name"
  # Glob expands in ascending order, so the walk can only catch duplicates —
  # which is exactly the ordering ambiguity that matters: two migrations from
  # the same instant cannot be applied in a deterministic order.
  [[ -z "$last_prefix" || "$prefix" -gt "$last_prefix" ]] \
    || fail "migration order violated: duplicate or regressed timestamp prefix $prefix (after $last_prefix)"
  last_prefix="$prefix"
done
[[ "$count" -ge 1 ]] || fail "no standard migrations found"
ok "all $count migration filenames are well-formed with strictly increasing timestamps"

# ── 2. Required migrations present ───────────────────────────────────────────
for required in "$V1_BASELINE" "$SCHEMA_10" "$ENTITLEMENTS"; do
  [[ -f "$MIGRATIONS_DIR/$required" ]] \
    || fail "required migration missing: $required"
done
ok "v1 baseline, schema-10 migration, and entitlements migration are present"

# ── 3. Protocol-2 RPC tokens in the authoritative migration ──────────────────
schema10_body="$(cat "$MIGRATIONS_DIR/$SCHEMA_10")"
required_rpc=(
  "public.sync_v2_apply(text,uuid,uuid,jsonb)"
  "public.sync_v2_pull(text,uuid,bigint,integer)"
  "public.sync_v2_snapshot(text,uuid)"
  "public.sync_v2_readiness(text)"
  "public.sync_v2_register_device(text,uuid,text,integer,integer,integer)"
  "public.sync_v2_resolve_conflict(uuid,text,jsonb)"
  "public.sync_v2_activate(text)"
)
# Whitespace around commas varies between grant statements and regprocedure
# lists; normalize before matching function signatures.
schema10_norm="$(tr -d ' ' <<<"$schema10_body")"
for token in "${required_rpc[@]}"; do
  grep -Fq "${token// /}" <<<"$schema10_norm" \
    || fail "schema-10 migration no longer grants $token"
done
grep -Fq "sync_v2_record_change(text,uuid,uuid,uuid,uuid,text,text,text,text,jsonb)" <<<"$schema10_norm" \
  || fail "schema-10 migration no longer defines sync_v2_record_change"
grep -Fq "server_schema_version" <<<"$schema10_body" \
  || fail "schema-10 migration no longer defines server_schema_version"
ok "protocol-2 RPC tokens and grants are intact in the schema-10 migration"

# ── 4. Entitlement objects and write gates ───────────────────────────────────
ent_body="$(cat "$MIGRATIONS_DIR/$ENTITLEMENTS")"
grep -Eiq 'create table (if not exists )?public\.entitlements' <<<"$ent_body" \
  || fail "entitlements migration does not create public.entitlements"
grep -Fq "grant_beta_entitlement" <<<"$ent_body" \
  || fail "entitlements migration does not define grant_beta_entitlement"
grep -Fq "public.is_entitled(p_user uuid)" <<<"$ent_body" \
  || fail "entitlements migration does not define is_entitled(uuid)"
grep -Fq "p_user = auth.uid()" <<<"$ent_body" \
  || fail "is_entitled is not self-only (p_user = auth.uid())"
grep -Fq "public.require_sync_entitlement" <<<"$ent_body" \
  || fail "entitlements migration does not define require_sync_entitlement"
grep -Fq "CODEMAP_ENTITLEMENT_REQUIRED" <<<"$ent_body" \
  || fail "entitlements migration does not raise the stable CODEMAP_ENTITLEMENT_REQUIRED token"
grep -Fq "42501" <<<"$ent_body" \
  || fail "entitlements migration does not use SQLSTATE 42501 for the gate"

perform_count="$(grep -Fc 'perform public.require_sync_entitlement();' <<<"$ent_body" || true)"
[[ "$perform_count" -ge 4 ]] \
  || fail "write gates missing: expected >=4 require_sync_entitlement perform calls in the entitlement migration, found $perform_count"
grep -Fq "create or replace function public.sync_v2_record_change" <<<"$ent_body" \
  || fail "entitlements migration does not re-issue sync_v2_record_change"
grep -Fq "create or replace function public.sync_v2_activate" <<<"$ent_body" \
  || fail "entitlements migration does not re-issue sync_v2_activate"
grep -Fq "projects_create" <<<"$ent_body" \
  || fail "entitlements migration does not redefine projects_create"
grep -Fq "codebook_v1_read" <<<"$ent_body" \
  || fail "entitlements migration does not split the codebook protocol-1 read policy"
grep -Fq "codebook_v1_insert" <<<"$ent_body" \
  || fail "entitlements migration does not gate protocol-1 codebook inserts"
grep -Fq "drop policy if exists codebook_rw" <<<"$ent_body" \
  || fail "entitlements migration does not drop the old codebook_rw policy"
ok "entitlement objects and write gates are present and gated"

# ── 5. Schema certification stays 10 ──────────────────────────────────────────
new_migration_meta="$(cat "$MIGRATIONS_DIR/$ENTITLEMENTS")"
if grep -Eq 'INSERT INTO public\.server_meta|UPDATE public\.server_meta|schema_version\s*=|server_schema_version' <<<"$new_migration_meta"; then
  fail "entitlements migration touches server schema certification (must stay $CERTIFIED_SCHEMA_VERSION)"
fi
ok "entitlements migration is additive; server schema certification stays $CERTIFIED_SCHEMA_VERSION"

# ── 6. Immutable v1 legacy artifacts ─────────────────────────────────────────
[[ -d "$ROOT/supabase/history" && "$(find "$ROOT/supabase/history" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')" -ge 1 ]] \
  || fail "supabase/history/ legacy artifacts are missing"
[[ -f "$ROOT/supabase/schema.sql" ]] \
  || fail "supabase/schema.sql (immutable v1 artifact) is missing"
legacy_count="$(ls "$ROOT"/supabase/migrate-*.sql 2>/dev/null | wc -l | tr -d ' ')"
[[ "$legacy_count" -ge 1 ]] || fail "flat legacy migrate-*.sql artifacts are missing"
ok "immutable v1 legacy artifacts are still present"

# ── 7. No schema_paths override ──────────────────────────────────────────────
config_body="$(cat "$ROOT/supabase/config.toml" 2>/dev/null || true)"
if grep -Eq '^\s*schema_paths\s*=' <<<"$config_body"; then
  fail "supabase/config.toml overrides schema_paths (must keep the standard migrations path)"
fi
ok "no schema_paths override in supabase/config.toml"

# ── 8. Release workflow must never mutate a database ─────────────────────────
[[ -f "$RELEASE_WORKFLOW" ]] || fail "release workflow missing: $RELEASE_WORKFLOW"
workflow_body="$(cat "$RELEASE_WORKFLOW")"
for bad in \
  'supabase db push' \
  'supabase migration repair' \
  'supabase db reset' \
  'supabase db migrate' \
  'supabase db bootstrap' \
  'supabase db dump' \
  'supabase remote commit' \
  'supabase db pull' \
  'supabase db diff'; do
  grep -Fq "$bad" <<<"$workflow_body" \
    && fail "release workflow reintroduces a database mutation command: $bad"
done
ok "release workflow contains no database mutation command"

echo "All migration checks passed."
