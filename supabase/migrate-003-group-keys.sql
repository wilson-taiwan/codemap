-- Codemap server migration 003 — group keys.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- RUN THIS ONCE in the Supabase SQL editor, before syncing a build that has
-- the group sheet in it. Safe to run twice; every statement is guarded.
--
-- WHY IT IS NEEDED
--
-- Joining used to be a single-use invitation the inviter minted per person,
-- with the coder's name fixed at minting time. That made "add my second
-- machine" and "add a third coder" into errands run by whoever held the
-- project, and it made the inviter responsible for spelling somebody else's
-- name. A group key replaces it: one persistent code per project that any
-- member can read and share, and the joiner confirms their own name on the
-- way in.
--
-- WHAT IT DOES NOT CHANGE
--
-- No transcript text is added to this database. `project_members.joined_at`
-- is a timestamp and `projects.group_key` is a random code; neither can carry
-- anything about a participant.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- The key that stands in for an invitation.
--
-- Eight characters from the same unambiguous alphabet the invite codes used
-- (no I, L, O, U). A group key is permanent rather than single-use, so it
-- gets two more characters than the six an invitation had: 32⁸ ≈ 1.1 trillion
-- draws, against a table that will hold a handful of projects.
alter table projects add column if not exists group_key text;

-- Backfill every existing project. Random draws inside a retry loop, because
-- a gen_random_uuid-derived value would need decoding machinery plpgsql does
-- not carry and the alphabet is 32 characters, not 16.
do $$
declare
  p record;
  candidate text;
  alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  i int;
begin
  for p in select project_id from projects where group_key is null loop
    loop
      candidate := '';
      for i in 1..8 loop
        candidate := candidate || substr(alphabet, 1 + floor(random() * 32)::int, 1);
      end loop;
      exit when not exists (select 1 from projects where group_key = candidate);
    end loop;
    update projects set group_key = candidate where project_id = p.project_id;
  end loop;
end $$;

alter table projects alter column group_key set not null;
create unique index if not exists projects_group_key_key on projects (group_key);

-- When each member joined, for the group roster. Existing members get the
-- migration's own timestamp; there is no older record to recover.
alter table project_members add column if not exists joined_at timestamptz not null default now();
update project_members set joined_at = now() where joined_at is null;
alter table project_members alter column joined_at set default now();
alter table project_members alter column joined_at set not null;

-- A group name is an attribution identity, not just a display label. Keep the
-- case-insensitive rule in the database too so two simultaneous joins cannot
-- both claim the same name after each saw an empty roster.
create unique index if not exists project_members_project_coder_name_ci_key
  on project_members (project_id, lower(coder_name));

-- ── Joining a group ──────────────────────────────────────────────────────────
--
-- `security definer` for the same reason `redeem_invite` is: a joiner is not
-- a member yet, which is precisely what every policy forbids. The hole is
-- narrow — present the key, join that one project, as yourself only.
--
-- Two differences from the invitation it replaces, both deliberate:
--
-- * The name comes from the joiner, not the inviter. `coder_name` is what
--   attribution on every coded row keys on, and the person who knows how
--   they want to be credited is the person typing it. The one rule is that
--   a name is one person: two members sharing a name would merge their
--   coding on the (passage, coder, span) key, attribution silently lost, so
--   a name already taken in the group is refused.
--
-- * Rejoining is the normal way one coder's second machine arrives, not an
--   error. The name on file wins and the one typed is ignored, so the second
--   machine files coding under the same name the first one does.
drop function if exists join_group(text, text);
create or replace function join_group(group_key text, coder_name text)
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

  -- The same forgiving normalisation the invite codes got: case is
  -- irrelevant, dashes and spaces are decoration, and the characters the
  -- alphabet avoids fold to the ones it uses.
  k := translate(upper(regexp_replace(coalesce(group_key, ''), '[^0-9A-Za-z]', '', 'g')), 'ILO', '110');
  n := nullif(btrim(coalesce(coder_name, '')), '');

  select p.* into proj from public.projects p where p.group_key = k;
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
    select 1 from public.project_members
    where project_id = proj.project_id and lower(project_members.coder_name) = lower(n)
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

revoke execute on function join_group(text, text) from anon, public;
grant execute on function join_group(text, text) to authenticated;

-- ── Renaming yourself ────────────────────────────────────────────────────────
--
-- The creator's name starts as their email address — `add_creator_as_member`
-- has nothing better — and a joiner can outgrow the name they typed on the
-- way in. One rule, same as joining: a name is one person in one group.
drop function if exists set_my_coder_name(text, text);
create or replace function set_my_coder_name(p_project_id text, p_coder_name text)
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
    select 1 from public.project_members
    where project_id = p_project_id
      and user_id <> auth.uid()
      and lower(project_members.coder_name) = lower(n)
  ) then
    raise exception 'Someone in this group already goes by that name. Pick a distinct one — add an initial or surname.';
  end if;

  -- A past coder's work remains visible even after they leave the membership
  -- table. Reusing that historical name would collide on the remote natural
  -- key, so reject it rather than silently merging two people's attribution.
  if lower(n) <> lower(old_name) and exists (
    select 1 from public.coded_segments c
     where c.project_id = p_project_id and lower(c.coder_name) = lower(n)
  ) then
    raise exception 'That name is already attached to coding in this group. Pick a distinct one — add an initial or surname.';
  end if;

  if n is distinct from old_name then
    update public.project_members
       set coder_name = n
     where project_id = p_project_id and user_id = auth.uid();

    -- Attribution belongs to the person, not the text they first typed. Bump
    -- revisions so every other machine pulls the renamed rows on its next run.
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

revoke execute on function set_my_coder_name(text, text) from anon, public;
grant execute on function set_my_coder_name(text, text) to authenticated;

notify pgrst, 'reload schema';
commit;
