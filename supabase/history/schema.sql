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
