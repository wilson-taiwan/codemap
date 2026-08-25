-- Codemap sync schema.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS AND IS NOT IN THIS DATABASE
--
-- Every row here is metadata *about* a coding decision. No transcript text, no
-- memo, no participant label, no filename, no interview date. Those are not
-- filtered out by the client — the columns they would land in DO NOT EXIST in
-- this schema. That is deliberate and it is the only enforcement that does not
-- depend on the application behaving correctly.
--
-- A full dump of this database yields: a project exists, it has N documents of
-- unknown content, two coders worked across these timestamps, a code hierarchy
-- with analytic labels, and a set of opaque ids pairing codes to passages.
-- Nothing here reconstructs into a participant.
--
-- The one free-text pair that DOES sync is codebook.name / codebook.definition.
-- Those are analytic constructs the researchers author and vet, not participant
-- utterances. They are also the genuine residual exposure: a label invented off
-- a single case leaks through analytic clothing. Audit labels before first sync.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Run this whole file once in the Supabase SQL editor.

create extension if not exists pgcrypto;

-- ── Tables ───────────────────────────────────────────────────────────────────

-- Ids are `text`, not `uuid`, on purpose: they are minted by SQLite on the
-- desktop side and are opaque to this database. Typing them as uuid would buy
-- nothing and would hard-fail any project whose ids ever deviated.
create table if not exists projects (
  project_id   text primary key,
  title        text not null,
  -- Segment ids only mean the same thing on two machines holding the same
  -- transcripts. The client refuses to sync when its corpus hash disagrees
  -- with this one; that is what stops coding being attached to the wrong text.
  corpus_hash  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Membership is the whole authorization model: every policy below reduces to
-- "is there a row here for you and this project".
--
-- Nothing a client sends can write to this table directly — there is no insert
-- policy. Rows appear by exactly two routes, both `security definer` functions
-- with narrow, stated conditions: `add_creator_as_member` when you create a
-- project, and `redeem_invite` when you present an unused, unexpired code.
create table if not exists project_members (
  project_id text not null references projects(project_id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  coder_name text not null,
  primary key (project_id, user_id)
);

create table if not exists codebook (
  id          text primary key,
  project_id  text not null references projects(project_id) on delete cascade,
  -- Length caps are a tripwire, not a formatting rule. A pasted participant
  -- quote is long; an analytic label and its definition are not. If a write
  -- ever trips these, something is putting the wrong thing in the wrong field.
  name        text not null check (length(name) <= 200),
  definition  text check (length(definition) <= 2000),
  parent_id   text,
  color       text check (length(color) <= 32),
  sort_order  integer not null default 0,
  is_retired  boolean not null default false,
  deleted     boolean not null default false,
  revision    integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- 🔴 There is no `memo` column here and there must never be one.
--
-- Locally, `coded_segments.memo` is a free-text column on this very row — the
-- coder's own writing about a participant's utterance. The desktop client sends
-- an explicit struct that omits it, but a client can have bugs; a column that
-- does not exist cannot receive a memo no matter what the client sends.
create table if not exists coded_segments (
  id           text primary key,
  project_id   text not null references projects(project_id) on delete cascade,
  interview_id text not null,
  segment_id   text not null,
  code_ids     text[] not null default '{}',
  coder_name   text not null check (length(coder_name) <= 120),
  deleted      boolean not null default false,
  revision     integer not null default 0,
  updated_at   timestamptz not null default now(),
  -- Character offsets of the coded span within the passage; null means the
  -- coding covers the whole speaker turn.
  --
  -- These are indices, not text. The receiving machine can only use them
  -- because it already holds the identical transcript — which the segment id
  -- proves, since that id is a hash of the passage's own words. Nothing about
  -- an offset reconstructs a participant.
  char_start   integer,
  char_end     integer,
  -- Mirrors the local upsert key. Two coders on one passage is two rows by
  -- design — in reflexive TA that divergence is data, not a duplicate — and so
  -- is one coder marking two different phrases inside a single turn.
  --
  -- `span_key` exists because the natural key includes two nullable columns,
  -- and in SQL two nulls are never equal: a plain unique over `char_start,
  -- char_end` would let unlimited duplicate whole-turn rows through, which is
  -- the exact bug this constraint was added to prevent. Collapsing the pair
  -- into one never-null text column restores ordinary unique semantics without
  -- depending on `nulls not distinct`.
  span_key     text generated always as (
                 coalesce(char_start::text, '*') || ':' || coalesce(char_end::text, '*')
               ) stored,
  constraint coded_segments_span_unique unique (project_id, segment_id, coder_name, span_key)
);

-- The interview roster. Enough to tell a coder that a transcript exists and
-- that they have imported the right one — and nothing else.
--
-- `study_label` is the one field here that is not a hash or a count. The
-- protocol already requires study IDs rather than names in every working file
-- ("P07", not a person), and this is the same constraint restated: whatever is
-- typed as a label ends up here, so it must be an ID. The length cap is a
-- tripwire for the case where someone types a name by habit.
--
-- There is no transcript, no date, no modality, no diagnosis note and no
-- filename. The interview id is itself derived from the label, so the two are
-- not independent facts.
create table if not exists interviews (
  id            text primary key,
  project_id    text not null references projects(project_id) on delete cascade,
  study_label   text not null check (length(study_label) <= 60),
  segment_count integer not null default 0,
  -- Of the transcript, so the other machine can prove it imported the same
  -- file rather than merely a file with the same name.
  content_hash  text,
  deleted       boolean not null default false,
  revision      integer not null default 0,
  updated_at    timestamptz not null default now()
);

-- An invitation to join a study.
--
-- This exists to move one decision — "this person is on the study" — out of the
-- SQL editor and into the app. Granting access previously meant looking up a
-- user id in the dashboard and hand-writing an insert into project_members,
-- which is four steps across two apps to express one thought.
--
-- The code is a bearer token: whoever holds it can join. That is the same
-- bargain as every invite link, and it is bounded the same way — single use,
-- an expiry, and revocable by deleting the row. `coder_name` is fixed by the
-- inviter rather than chosen by the joiner, so attribution on coded rows cannot
-- be claimed by whoever redeems it.
create table if not exists project_invites (
  code        text primary key,
  project_id  text not null references projects(project_id) on delete cascade,
  coder_name  text not null check (length(coder_name) <= 120),
  created_by  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users(id) on delete set null
);

create index if not exists coded_segments_pull_idx
  on coded_segments (project_id, updated_at);
create index if not exists codebook_pull_idx
  on codebook (project_id, updated_at);
create index if not exists interviews_pull_idx
  on interviews (project_id, updated_at);

-- ── Server-authoritative timestamps ──────────────────────────────────────────
--
-- `updated_at` is both the merge tiebreaker and the pull cursor, so it must not
-- come from the clients. Two laptops with a few seconds of clock skew would
-- otherwise resolve conflicts backwards and, worse, a client whose clock runs
-- slow could write rows *behind* the other's cursor and never be pulled at all.
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists codebook_touch on codebook;
create trigger codebook_touch before insert or update on codebook
  for each row execute function touch_updated_at();

drop trigger if exists coded_segments_touch on coded_segments;
create trigger coded_segments_touch before insert or update on coded_segments
  for each row execute function touch_updated_at();

drop trigger if exists projects_touch on projects;
create trigger projects_touch before insert or update on projects
  for each row execute function touch_updated_at();

drop trigger if exists interviews_touch on interviews;
create trigger interviews_touch before insert or update on interviews
  for each row execute function touch_updated_at();

-- ── Creating a project ───────────────────────────────────────────────────────
--
-- Whoever inserts a project becomes its first member, in the same transaction.
-- Without this the two rules contradict each other: you may only touch a
-- project you are a member of, and membership requires the project to exist —
-- so nobody could ever create the first one from the app, and every new study
-- began with hand-written SQL.
--
-- `security definer` because the insert it performs is exactly the thing the
-- policy on project_members forbids clients from doing for themselves. That is
-- the point: the creator is added automatically, and everyone *else* is added
-- deliberately, by you, in the dashboard.
create or replace function add_creator_as_member() returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into project_members (project_id, user_id, coder_name)
  values (new.project_id, auth.uid(), coalesce(
    nullif(current_setting('request.jwt.claims', true)::json->>'email', ''),
    'coder'
  ))
  on conflict (project_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists projects_add_creator on projects;
create trigger projects_add_creator after insert on projects
  for each row execute function add_creator_as_member();

-- ── Row-level security ───────────────────────────────────────────────────────
--
-- Written before any data lands, which is the only order that is ever safe.

alter table projects        enable row level security;
alter table project_members enable row level security;
alter table codebook        enable row level security;
alter table coded_segments  enable row level security;
alter table interviews      enable row level security;
alter table project_invites enable row level security;

-- `security definer` breaks what would otherwise be infinite recursion: a policy
-- on project_members that itself queries project_members.
create or replace function is_project_member(p text) returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from project_members m
    where m.project_id = p and m.user_id = auth.uid()
  );
$$;

drop policy if exists members_read on project_members;
create policy members_read on project_members
  for select using (user_id = auth.uid() or is_project_member(project_id));

drop policy if exists projects_rw on projects;
create policy projects_rw on projects
  for all using (is_project_member(project_id))
  with check (is_project_member(project_id));

-- Creating is separate from the rest: `using` cannot apply to an INSERT (there
-- is no existing row to test), and the membership that `projects_rw` demands is
-- created by the trigger above as part of the same statement.
drop policy if exists projects_create on projects;
create policy projects_create on projects
  for insert to authenticated with check (true);

-- Members issue and revoke invites for their own study. Redemption bypasses
-- this deliberately, through `redeem_invite` above — a joiner is by definition
-- not a member yet, so no policy here could ever let them in.
drop policy if exists invites_rw on project_invites;
create policy invites_rw on project_invites
  for all using (is_project_member(project_id))
  with check (is_project_member(project_id));

drop policy if exists interviews_rw on interviews;
create policy interviews_rw on interviews
  for all using (is_project_member(project_id))
  with check (is_project_member(project_id));

drop policy if exists codebook_rw on codebook;
create policy codebook_rw on codebook
  for all using (is_project_member(project_id))
  with check (is_project_member(project_id));

drop policy if exists coded_segments_rw on coded_segments;
create policy coded_segments_rw on coded_segments
  for all using (is_project_member(project_id))
  with check (is_project_member(project_id));

-- No insert/update/delete policy exists on project_members, so those are denied
-- for every client. Adding a coder is a deliberate act performed in the
-- dashboard, not something the app can do to itself.

-- ── Redeeming an invite ──────────────────────────────────────────────────────
--
-- `security definer` because this is the one operation that must work for
-- somebody who is *not yet* a member — which is precisely what every policy
-- here otherwise forbids. It is the narrowest possible hole: it grants
-- membership of one named project, to the caller only, in exchange for an
-- unexpired unused code, and it burns the code on the way through.
--
-- Note what it does not do. It does not take a project id, so a valid code
-- cannot be pointed at a different study. It does not take a coder name, so a
-- joiner cannot file their coding under somebody else's name. Both come off the
-- invite row, written by the person who issued it.
-- Returns both the project and the name the inviter assigned, so the joining
-- app never has to ask for a name the invitation already settled. A dropped
-- first: a return type cannot be changed by `create or replace`.
drop function if exists redeem_invite(text);
create or replace function redeem_invite(invite_code text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  inv public.project_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in before redeeming an invite.';
  end if;

  -- FOR UPDATE so two simultaneous redemptions of one code cannot both pass
  -- the unused check before either marks it used.
  select * into inv
    from public.project_invites
   where code = invite_code
     and redeemed_at is null
     and expires_at > now()
   for update;

  if not found then
    raise exception 'That invite is not valid. It may have been used already, or expired.';
  end if;

  insert into public.project_members (project_id, user_id, coder_name)
  values (inv.project_id, auth.uid(), inv.coder_name)
  on conflict (project_id, user_id) do nothing;

  update public.project_invites
     set redeemed_at = now(), redeemed_by = auth.uid()
   where code = inv.code;

  return jsonb_build_object(
    'project_id', inv.project_id,
    'coder_name', inv.coder_name
  );
end;
$$;

-- Signed-in callers only. An anonymous caller must not be able to burn invites.
revoke execute on function redeem_invite(text) from anon, public;
grant execute on function redeem_invite(text) to authenticated;

-- ── Adding a coder by hand ───────────────────────────────────────────────────
--
-- Normally you will never need this: **Invite a coder** in the app issues a
-- code, and redeeming it adds them. This is the manual equivalent, kept for
-- when an invite has expired and the person is standing next to you.
--
-- Find the user id under Authentication → Users, then:
--
--   insert into project_members (project_id, user_id, coder_name)
--   values ('<project id, shown in the app's sync sheet>',
--           '<their user id>',
--           '<their coder name>');
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
