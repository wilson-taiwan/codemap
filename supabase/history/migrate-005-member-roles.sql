-- Codemap server migration 005 — group roles and admin RPCs.
--
-- RUN THIS ONCE in the Supabase SQL editor. Safe to run twice; every statement is guarded.

begin;

-- 1. Add role column to project_members
alter table public.project_members add column if not exists role text;
update public.project_members set role = 'coder' where role is null or role not in ('admin', 'coder');

-- 2. Backfill: every project's earliest member by joined_at gets role = 'admin' (if no admin yet)
with earliest_members as (
  select distinct on (project_id) project_id, user_id
    from public.project_members
   order by project_id, joined_at asc
)
update public.project_members m
   set role = 'admin'
  from earliest_members e
 where m.project_id = e.project_id
   and m.user_id = e.user_id
   and not exists (
     select 1 from public.project_members a
      where a.project_id = m.project_id and a.role = 'admin'
   );

alter table public.project_members alter column role set default 'coder';
alter table public.project_members alter column role set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public' and t.relname = 'project_members' and c.conname = 'project_members_role_check'
  ) then
    alter table public.project_members
      add constraint project_members_role_check check (role in ('admin', 'coder'));
  end if;
end $$;

-- 3. Update add_creator_as_member trigger to assign role = 'admin' to project creators
create or replace function public.add_creator_as_member() returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.project_members (project_id, user_id, coder_name, role)
  values (
    new.project_id,
    auth.uid(),
    coalesce(
      nullif(current_setting('request.jwt.claims', true)::json->>'email', ''),
      'coder'
    ),
    'admin'
  )
  on conflict (project_id, user_id) do nothing;
  return new;
end;
$$;

-- 4. RPC: set_member_role
drop function if exists public.set_member_role(text, uuid, text);
create or replace function public.set_member_role(
  p_project_id text,
  p_user_id uuid,
  p_role text
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  caller_role text;
  admin_count int;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  if p_role not in ('admin', 'coder') then
    raise exception 'Invalid role. Must be admin or coder.';
  end if;

  select m.role into caller_role
    from public.project_members m
   where m.project_id = p_project_id and m.user_id = auth.uid();

  if caller_role is distinct from 'admin' then
    raise exception 'Only group administrators can change member roles.';
  end if;

  if not exists (
    select 1 from public.project_members m
     where m.project_id = p_project_id and m.user_id = p_user_id
  ) then
    raise exception 'Member not found in this group.';
  end if;

  if p_user_id = auth.uid() and p_role = 'coder' then
    select count(*) into admin_count
      from public.project_members m
     where m.project_id = p_project_id and m.role = 'admin';

    if admin_count <= 1 then
      raise exception 'Cannot demote the only administrator. Promote another member to admin first.';
    end if;
  end if;

  update public.project_members
     set role = p_role
   where project_id = p_project_id and user_id = p_user_id;
end;
$$;

revoke execute on function public.set_member_role(text, uuid, text) from anon, public;
grant execute on function public.set_member_role(text, uuid, text) to authenticated;

-- 5. RPC: remove_member
drop function if exists public.remove_member(text, uuid);
create or replace function public.remove_member(
  p_project_id text,
  p_user_id uuid
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  caller_role text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  select m.role into caller_role
    from public.project_members m
   where m.project_id = p_project_id and m.user_id = auth.uid();

  if caller_role is distinct from 'admin' then
    raise exception 'Only group administrators can remove members.';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'You cannot remove yourself from the group. Transfer administration first or ask another administrator.';
  end if;

  if not exists (
    select 1 from public.project_members m
     where m.project_id = p_project_id and m.user_id = p_user_id
  ) then
    raise exception 'Member not found in this group.';
  end if;

  delete from public.project_members
   where project_id = p_project_id and user_id = p_user_id;
end;
$$;

revoke execute on function public.remove_member(text, uuid) from anon, public;
grant execute on function public.remove_member(text, uuid) to authenticated;

-- 6. RPC: reset_group_key
drop function if exists public.reset_group_key(text);
create or replace function public.reset_group_key(p_project_id text)
returns text
language plpgsql security definer
set search_path = public
as $$
declare
  caller_role text;
  candidate text;
  alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  i int;
  tries int := 0;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  select m.role into caller_role
    from public.project_members m
   where m.project_id = p_project_id and m.user_id = auth.uid();

  if caller_role is distinct from 'admin' then
    raise exception 'Only group administrators can reset the group key.';
  end if;

  loop
    candidate := '';
    for i in 1..8 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;
    exit when not exists (select 1 from public.projects where group_key = candidate);
    tries := tries + 1;
    if tries > 10 then
      raise exception 'Could not generate unique group key after 10 attempts.';
    end if;
  end loop;

  update public.projects
     set group_key = candidate
   where project_id = p_project_id;

  return candidate;
end;
$$;

revoke execute on function public.reset_group_key(text) from anon, public;
grant execute on function public.reset_group_key(text) to authenticated;

-- 7. RPC: delete_group
drop function if exists public.delete_group(text, text);
create or replace function public.delete_group(
  p_project_id text,
  p_confirm_title text
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  caller_role text;
  current_title text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  select m.role into caller_role
    from public.project_members m
   where m.project_id = p_project_id and m.user_id = auth.uid();

  if caller_role is distinct from 'admin' then
    raise exception 'Only group administrators can delete a group.';
  end if;

  select p.title into current_title
    from public.projects p
   where p.project_id = p_project_id;

  if not found then
    raise exception 'Group not found.';
  end if;

  if btrim(p_confirm_title) <> btrim(current_title) then
    raise exception 'Confirmation title does not match group title.';
  end if;

  delete from public.projects
   where project_id = p_project_id;
end;
$$;

revoke execute on function public.delete_group(text, text) from anon, public;
grant execute on function public.delete_group(text, text) to authenticated;

notify pgrst, 'reload schema';
commit;
