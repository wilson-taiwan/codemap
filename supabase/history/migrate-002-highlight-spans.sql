-- Codemap server migration 002 — highlight-level coding.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- RUN THIS ONCE in the Supabase SQL editor, before syncing a build that has
-- highlight coding in it. Safe to run twice; every statement is guarded.
--
-- WHY IT IS NEEDED
--
-- Coding used to be one row per (passage, coder), so a coder held exactly one
-- opinion per speaker turn. Marking a second phrase inside a turn overwrote the
-- first. The key now includes the span, so a coder may code a whole turn *and*
-- mark distinct phrases within it.
--
-- WHAT IT DOES NOT CHANGE
--
-- No transcript text is added to this database. `char_start` and `char_end` are
-- integer offsets into a transcript the receiving machine already holds — it
-- holds it because the segment id, a hash of the passage's own words, proved
-- the two files identical. An offset without the text is a pair of numbers.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

alter table coded_segments add column if not exists char_start integer;
alter table coded_segments add column if not exists char_end   integer;

-- The natural key has two nullable columns, and two nulls are never equal in
-- SQL — so a plain unique over them would let unlimited duplicate whole-turn
-- rows through, reintroducing the bug the original constraint prevented.
-- Folding the pair into one never-null generated column restores ordinary
-- unique semantics without relying on `nulls not distinct`, which needs a
-- newer Postgres than this migration is willing to assume.
alter table coded_segments add column if not exists span_key text
  generated always as (
    coalesce(char_start::text, '*') || ':' || coalesce(char_end::text, '*')
  ) stored;

alter table coded_segments
  drop constraint if exists coded_segments_project_id_segment_id_coder_name_key;

do $$
declare
  r record;
  canonical_found boolean := false;
begin
  -- Inspect all unique constraints on coded_segments covering exactly (project_id, segment_id, coder_name, span_key)
  for r in (
    select c.conname, (c.conname = 'coded_segments_span_unique') as is_canonical
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'coded_segments'
       and c.contype = 'u'
       and (
         select array_agg(a.attname order by k.ordinality)
           from unnest(c.conkey) with ordinality as k(attnum, ordinality)
           join pg_attribute a
             on a.attrelid = c.conrelid and a.attnum = k.attnum
       ) = array['project_id', 'segment_id', 'coder_name', 'span_key']::name[]
     order by (c.conname = 'coded_segments_span_unique') desc, c.conname asc
  ) loop
    if not canonical_found then
      if not r.is_canonical then
        execute format('alter table public.coded_segments rename constraint %I to coded_segments_span_unique', r.conname);
      end if;
      canonical_found := true;
    else
      -- Extra duplicate equivalent constraint
      execute format('alter table public.coded_segments drop constraint %I', r.conname);
    end if;
  end loop;

  if not canonical_found then
    alter table public.coded_segments
      add constraint coded_segments_span_unique
      unique (project_id, segment_id, coder_name, span_key);
  end if;
end $$;

notify pgrst, 'reload schema';
commit;
