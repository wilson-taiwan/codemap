-- Codemap server migration 008 — server schema version & migration certification.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- RUN THIS ONCE in the Supabase SQL editor. Safe to run twice; every statement
-- is idempotent.
--
-- WHY IT IS NEEDED
--
-- Provides a validated schema version handshake (public.server_schema_version())
-- so the Codemap client can verify the database has all required migrations
-- (002 through 008) deployed and functioning.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.server_meta (
  id smallint primary key,
  schema_version integer not null check (schema_version >= 0),
  constraint server_meta_singleton check (id = 1)
);

alter table public.server_meta enable row level security;
revoke all on table public.server_meta from public, anon, authenticated;

-- Version 8 means every earlier migration is present. Refuse to certify 8
-- when the operator skipped a file or Realtime is not actually published.
do $$
declare
  missing text[] := array[]::text[];
  required_column text;
  required_function text;
  required_table text;
  norm_gen_expr text;
  gen_expr_raw text;
  fn_oid oid;
  fn_has_secdef boolean;
  fn_has_search_path boolean;
  fn_auth_exec boolean;
  fn_anon_exec boolean;
  fn_pub_exec boolean;
begin
  -- 1. Validate server_meta table structure and privileges
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'server_meta'
  ) then
    if not exists (
      select 1 from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'server_meta'
       and c.conname = 'server_meta_singleton'
    ) then
      missing := array_append(missing, 'server_meta:singleton_check');
    end if;

    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'server_meta'
       and c.relrowsecurity = true
    ) then
      missing := array_append(missing, 'server_meta:rls_enabled');
    end if;
  end if;

  -- 2. Required columns
  foreach required_column in array array[
    'coded_segments.char_start', 'coded_segments.char_end', 'coded_segments.span_key',
    'projects.group_key', 'projects.merge_same_speaker',
    'project_members.joined_at', 'project_members.role'
  ] loop
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = split_part(required_column, '.', 1)
         and column_name = split_part(required_column, '.', 2)
    ) then
      missing := array_append(missing, required_column);
    end if;
  end loop;

  -- 3. Stored generated span_key column check
  select pg_get_expr(adbin, adrelid) into gen_expr_raw
    from pg_attrdef a
    join pg_class c on c.oid = a.adrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute att on att.attrelid = c.oid and att.attnum = a.adnum
   where n.nspname = 'public'
     and c.relname = 'coded_segments'
     and att.attname = 'span_key';

  if gen_expr_raw is null then
    missing := array_append(missing, 'coded_segments.span_key:generated');
  else
    norm_gen_expr := replace(replace(replace(replace(replace(lower(gen_expr_raw), '::text', ''), ' ', ''), '(', ''), ')', ''), '''', '');
    if norm_gen_expr <> 'coalescechar_start,*||:||coalescechar_end,*' then
      missing := array_append(missing, 'coded_segments.span_key:expression_mismatch');
    end if;
  end if;

  -- 4. Column permissions on projects
  if not exists (
    select 1 from information_schema.column_privileges
     where table_schema = 'public'
       and table_name = 'projects'
       and column_name = 'corpus_hash'
       and privilege_type = 'UPDATE'
       and grantee = 'authenticated'
  ) then
    missing := array_append(missing, 'privilege:projects.corpus_hash:authenticated_update');
  end if;

  if not exists (
    select 1 from information_schema.column_privileges
     where table_schema = 'public'
       and table_name = 'projects'
       and column_name = 'merge_same_speaker'
       and privilege_type = 'UPDATE'
       and grantee = 'authenticated'
  ) then
    missing := array_append(missing, 'privilege:projects.merge_same_speaker:authenticated_update');
  end if;

  -- 5. Nullability & unique constraints / indexes
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'projects' and column_name = 'group_key' and is_nullable = 'YES'
  ) then
    missing := array_append(missing, 'projects.group_key:not_null');
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'project_members' and column_name = 'joined_at' and is_nullable = 'YES'
  ) then
    missing := array_append(missing, 'project_members.joined_at:not_null');
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'project_members' and column_name = 'role' and is_nullable = 'YES'
  ) then
    missing := array_append(missing, 'project_members.role:not_null');
  end if;

  if not exists (
    select 1
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'coded_segments'
       and c.conname = 'coded_segments_span_unique'
       and c.contype = 'u'
       and (
         select array_agg(a.attname order by k.ordinality)
           from unnest(c.conkey) with ordinality as k(attnum, ordinality)
           join pg_attribute a
             on a.attrelid = c.conrelid and a.attnum = k.attnum
       ) = array['project_id', 'segment_id', 'coder_name', 'span_key']::name[]
  ) then
    missing := array_append(missing, 'coded_segments_span_unique');
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'projects' and indexname = 'projects_group_key_key'
  ) then
    missing := array_append(missing, 'projects_group_key_key');
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'project_members' and indexname = 'project_members_project_coder_name_ci_key'
  ) then
    missing := array_append(missing, 'project_members_project_coder_name_ci_key');
  end if;

  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and t.relname = 'project_members' and c.conname = 'project_members_role_check'
  ) then
    missing := array_append(missing, 'project_members_role_check');
  end if;

  -- 6. Creator hook and trigger
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'add_creator_as_member'
     and p.prosecdef = true
     and array_to_string(p.proconfig, ',') like '%search_path=public%'
  ) then
    missing := array_append(missing, 'add_creator_as_member:secdef_search_path');
  end if;

  if not exists (
    select 1 from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'projects'
     and tg.tgname = 'projects_add_creator'
     and tg.tgenabled <> 'D'
  ) then
    missing := array_append(missing, 'projects_add_creator:trigger');
  end if;

  -- 7. Functions by exact signature, security definer, search_path, and ACLs
  foreach required_function in array array[
    'join_group(text,text)', 'set_my_coder_name(text,text)',
    'set_member_role(text,uuid,text)', 'remove_member(text,uuid)',
    'reset_group_key(text)', 'delete_group(text,text)', 'leave_group(text)',
    'redeem_invite(text)'
  ] loop
    fn_oid := to_regprocedure('public.' || required_function);
    if fn_oid is null then
      missing := array_append(missing, required_function);
    else
      select p.prosecdef,
             coalesce(array_to_string(p.proconfig, ',') like '%search_path=public%', false)
        into fn_has_secdef, fn_has_search_path
        from pg_proc p
       where p.oid = fn_oid;

      if not (fn_has_secdef and fn_has_search_path) then
        missing := array_append(missing, required_function || ':secdef_search_path');
      end if;

      -- Check execute permissions: all functions must be executable by authenticated
      fn_auth_exec := has_function_privilege('authenticated', fn_oid, 'execute');
      if not fn_auth_exec then
        missing := array_append(missing, required_function || ':permissions');
      end if;
    end if;
  end loop;

  -- 8. Realtime publication and replica identity full
  foreach required_table in array array['coded_segments', 'codebook', 'interviews'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = required_table
    ) then
      missing := array_append(missing, 'supabase_realtime:' || required_table);
    end if;
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname = required_table
         and c.relreplident = 'f'
    ) then
      missing := array_append(missing, 'replica_identity_full:' || required_table);
    end if;
  end loop;

  if cardinality(missing) > 0 then
    raise exception 'Cannot record Codemap schema 8; missing: %',
      array_to_string(missing, ', ');
  end if;
end $$;

insert into public.server_meta (id, schema_version) values (1, 8)
  on conflict (id) do update
  set schema_version = greatest(public.server_meta.schema_version, excluded.schema_version);

create or replace function public.server_schema_version()
returns integer language sql stable security definer set search_path = public
as $$ select schema_version from public.server_meta where id = 1 $$;

revoke execute on function public.server_schema_version() from public;
grant execute on function public.server_schema_version() to anon, authenticated;

notify pgrst, 'reload schema';
commit;
