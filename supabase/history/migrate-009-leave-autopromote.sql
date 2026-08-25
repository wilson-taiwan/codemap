-- Codemap server migration 009 — leave_group auto-promotes instead of blocking the sole admin.
--
-- RUN THIS ONCE in the Supabase SQL editor. Safe to run twice; idempotent.
--
-- Behavior change only; leave_group(text) keeps its signature, security definer,
-- search_path, and grants, so migration 008's certification still holds and the
-- client's required schema version stays 8. Old clients keep working — they now
-- get auto-promotion where they previously got an error.

begin;

drop function if exists public.leave_group(text);
create or replace function public.leave_group(p_project_id text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  caller_role text;
  admin_count int;
  promote_uid uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  select m.role into caller_role
    from public.project_members m
   where m.project_id = p_project_id and m.user_id = auth.uid();

  if caller_role is null then
    raise exception 'You are not a member of this study.';
  end if;

  -- If the caller is the sole admin, promote the earliest-joined other member
  -- (if any) so the study is never left without an administrator. When the caller
  -- is the only member at all, there is no one to promote and the leave proceeds,
  -- leaving the study memberless (its data is untouched). Leaving is never blocked.
  if caller_role = 'admin' then
    select count(*) into admin_count
      from public.project_members m
     where m.project_id = p_project_id and m.role = 'admin';

    if admin_count <= 1 then
      select m.user_id into promote_uid
        from public.project_members m
       where m.project_id = p_project_id
         and m.user_id <> auth.uid()
       order by m.joined_at asc, m.user_id asc
       limit 1;

      if promote_uid is not null then
        update public.project_members
           set role = 'admin'
         where project_id = p_project_id and user_id = promote_uid;
      end if;
    end if;
  end if;

  -- Delete only the caller's membership row. Coding and codebook are untouched.
  delete from public.project_members
   where project_id = p_project_id and user_id = auth.uid();
end;
$$;

revoke execute on function public.leave_group(text) from anon, public;
grant execute on function public.leave_group(text) to authenticated;

notify pgrst, 'reload schema';
commit;
