-- Codemap server migration 006 — pinned parse setting and leave_group RPC.
--
-- RUN THIS ONCE in the Supabase SQL editor. Safe to run twice; every statement is idempotent.
--
-- Note: Run via Supabase SQL editor or CLI. Clients older than 0.22.0 ignore merge_same_speaker
-- entirely and continue using their local preferences.

begin;

-- 1. Add merge_same_speaker column to projects (nullable: null means predates pinning)
alter table public.projects
  add column if not exists merge_same_speaker boolean;

-- 2. Grant column-level update permission so ordinary members can pin merge_same_speaker
-- without widening access to project deletion or renaming.
grant update (corpus_hash, merge_same_speaker) on table public.projects to authenticated;

-- 3. RPC: leave_group
drop function if exists public.leave_group(text);
create or replace function public.leave_group(p_project_id text)
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

  select m.role into caller_role
    from public.project_members m
   where m.project_id = p_project_id and m.user_id = auth.uid();

  if caller_role is null then
    raise exception 'You are not a member of this study.';
  end if;

  -- If the caller is an admin, ensure they are not the sole admin
  if caller_role = 'admin' then
    select count(*) into admin_count
      from public.project_members m
     where m.project_id = p_project_id and m.role = 'admin';

    if admin_count <= 1 then
      raise exception 'You are the only admin. Promote another member before leaving.';
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
