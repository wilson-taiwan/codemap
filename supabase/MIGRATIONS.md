# Codemap Supabase Migrations

`supabase/migrations/` is the only executable migration path. The original v1
schema and flat migration files remain under `supabase/history/` and at their
legacy paths as immutable evidence; they are not discovered by the CLI.

| Standard migration | Purpose |
| --- | --- |
| `20260823000000_v1_certified_baseline.sql` | Builds the certified v1 schema represented by the historical schema plus migrations 002–009. |
| `20260823000001_sync_protocol_v2_schema_10.sql` | Adds Sync Protocol v2, its ordered log/materialized state/RPCs, the protocol-1 lockout, and server-schema certification version 10. |

## Local verification

Run from the repository root. These commands only target the local Supabase
stack. They must never be pointed at production for routine development.

```bash
bash scripts/verify-supabase-migrations.sh
supabase db reset --local --no-seed
supabase db lint --local
bash scripts/test-local-supabase-v2.sh
```

After starting local Supabase, certify the local API through the public RPC
using local non-secret development credentials:

```bash
bash scripts/check-server-schema.sh 10
```

The verification script rejects absent or misordered standard migrations,
missing schema-10 RPCs, a nonstandard `schema_paths` override, and any release
workflow that reintroduces a database mutation command.

## Production migration procedure

The project maintainer reviews and applies production schema changes. Production migration
is a manual, reviewed operation. The release workflow verifies history and schema;
it does not run `supabase db push`, migration repair, or mutating SQL.

1. Schedule a maintenance window and take a provider-managed backup. Record
   its timestamp and restoration procedure outside this repository.
2. From a trusted local shell, inspect the migration diff and current remote
   migration history. Do not paste a database URL, token, or output containing
   credentials into tickets, chat, or this repository.
3. Verify the existing database is certified at v8 and that the migrate-009
   `leave_group` behavior is present. A matching table list alone is not
   sufficient evidence for historical migration state.
4. Reconcile the one-time v1 baseline history entry only after reviewing the
   actual remote history and the v8/migrate-009 probes. Record the decision and
   evidence with the change request. Do not guess from table names.
5. Review and apply the schema-10 migration from the trusted shell. If it
   fails, keep the database at its last committed transaction state and make a
   forward corrective migration; never edit an applied migration or downgrade
   a protocol-2 study.
6. Run the read-only server certification (`scripts/check-server-schema.sh 10`)
   and inspect the remote migration list. Record version, history alignment,
   timestamp, operator, and any baseline-reconciliation evidence.
7. Only after certification may a v0.27 client register readiness. Study
   activation remains a separate per-study RPC/UI action and is irreversible.

## Recovery boundary

The v2 migration is transactional. A failed migration rolls back as one unit.
Once a study activates protocol 2, do not attempt a downgrade: use a reviewed
forward corrective migration and preserve the immutable change log. Production
database changes, update publication, release tags, and artifact uploads are
outside this implementation plan.
