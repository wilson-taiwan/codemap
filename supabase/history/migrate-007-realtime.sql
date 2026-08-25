-- Codemap server migration 007 — enable Realtime publication for synced tables.
--
-- RUN THIS ONCE in the Supabase SQL editor. Safe to run twice.
--
-- NOTE FOR THE OPERATOR:
-- Realtime payloads cross the wire to subscribed clients as Phoenix channel messages.
-- The client treats these payloads purely as an invalidation notification (a signal to
-- issue a debounced REST pull), NEVER as direct data to write to SQLite.
-- The privacy boundary holds because Rust is the sole network path and only `apply_pull`
-- folds data into SQLite via the 3-way merge rules.
--

begin;

-- 1. Add the three synced tables to the Realtime publication (idempotent).
-- Realtime respects RLS, so a subscriber still only receives rows for studies
-- they are a member of — the same is_project_member() check that governs REST.
do $$
declare
  tbl text;
begin
  for tbl in select unnest(array['coded_segments', 'codebook', 'interviews']) loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = tbl
    ) then
      execute format('alter publication supabase_realtime add table public.%I', tbl);
    end if;
  end loop;
end $$;

-- 2. REPLICA IDENTITY FULL so the payload carries the whole row rather than just
-- the primary key. The client uses only project_id from it — as a signal to
-- pull, never as data to apply — but a key-only payload cannot even be
-- filtered by project.
alter table public.coded_segments replica identity full;
alter table public.codebook       replica identity full;
alter table public.interviews     replica identity full;

notify pgrst, 'reload schema';
commit;
