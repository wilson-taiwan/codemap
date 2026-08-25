-- Codemap server migration 004 — repair the group RPC contract.
--
-- Migration 003 reached the database with RPC argument and result names that
-- did not match the Rust client. That made starting or joining a group fail at
-- the PostgREST boundary before any membership was changed. This migration is
-- intentionally standalone so databases where 003 already ran get the same
-- repair as a fresh database.

begin;

create unique index if not exists project_members_project_coder_name_ci_key
  on public.project_members (project_id, lower(coder_name));

drop function if exists public.join_group(text, text);
create function public.join_group(group_key text, coder_name text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  k text;
  n text;
  proj public.projects%rowtype;
  existing_name text;
begin
  if auth.uid() is null then
    raise exception 'Sign in before joining a group.';
  end if;

  k := translate(
    upper(regexp_replace(coalesce(group_key, ''), '[^0-9A-Za-z]', '', 'g')),
    'ILO',
    '110'
  );
  n := nullif(btrim(coalesce(coder_name, '')), '');

  select p.* into proj
    from public.projects p
   where p.group_key = k;
  if not found then
    raise exception 'That group key is not valid. Check for a typo — or ask the group to reset the key and send the new one.';
  end if;

  select m.coder_name into existing_name
    from public.project_members m
   where m.project_id = proj.project_id and m.user_id = auth.uid();
  if found then
    return jsonb_build_object(
      'project_id', proj.project_id,
      'title', proj.title,
      'coder_name', existing_name,
      'created', false
    );
  end if;

  if n is null then
    raise exception 'Choose the name your coding should be filed under.';
  end if;
  if length(n) > 120 then
    raise exception 'That name is too long — 120 characters is the limit.';
  end if;
  if exists (
    select 1
      from public.project_members m
     where m.project_id = proj.project_id and lower(m.coder_name) = lower(n)
  ) then
    raise exception 'Someone in this group already goes by that name. Pick a distinct one — add an initial or surname.';
  end if;

  insert into public.project_members (project_id, user_id, coder_name)
  values (proj.project_id, auth.uid(), n);

  return jsonb_build_object(
    'project_id', proj.project_id,
    'title', proj.title,
    'coder_name', n,
    'created', true
  );
end;
$$;

revoke execute on function public.join_group(text, text) from anon, public;
grant execute on function public.join_group(text, text) to authenticated;

drop function if exists public.set_my_coder_name(text, text);
create function public.set_my_coder_name(p_project_id text, p_coder_name text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  n text;
  old_name text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  n := nullif(btrim(coalesce(p_coder_name, '')), '');
  if n is null then
    raise exception 'Choose the name your coding should be filed under.';
  end if;
  if length(n) > 120 then
    raise exception 'That name is too long — 120 characters is the limit.';
  end if;

  select m.coder_name into old_name
    from public.project_members m
   where m.project_id = p_project_id and m.user_id = auth.uid()
   for update;
  if not found then
    raise exception 'You are not a member of that group.';
  end if;

  if exists (
    select 1
      from public.project_members m
     where m.project_id = p_project_id
       and m.user_id <> auth.uid()
       and lower(m.coder_name) = lower(n)
  ) then
    raise exception 'Someone in this group already goes by that name. Pick a distinct one — add an initial or surname.';
  end if;

  if lower(n) <> lower(old_name) and exists (
    select 1
      from public.coded_segments c
     where c.project_id = p_project_id and lower(c.coder_name) = lower(n)
  ) then
    raise exception 'That name is already attached to coding in this group. Pick a distinct one — add an initial or surname.';
  end if;

  if n is distinct from old_name then
    update public.project_members
       set coder_name = n
     where project_id = p_project_id and user_id = auth.uid();

    update public.coded_segments
       set coder_name = n, revision = revision + 1, updated_at = now()
     where project_id = p_project_id and lower(coder_name) = lower(old_name);
  end if;

  return jsonb_build_object(
    'coder_name', n,
    'previous_name', old_name
  );
end;
$$;

revoke execute on function public.set_my_coder_name(text, text) from anon, public;
grant execute on function public.set_my_coder_name(text, text) to authenticated;

notify pgrst, 'reload schema';
commit;
