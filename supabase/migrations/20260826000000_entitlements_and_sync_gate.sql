-- ─────────────────────────────────────────────────────────────────────────────
-- 20260826000000: per-user hosted-sync entitlement substrate + write gates
--
-- Additive migration for Codemap 1.1.0. Server schema certification stays at
-- version 10 so the installed 1.0.0 base keeps syncing while this rolls out.
--
-- Product model (see supabase/MIGRATIONS.md):
--   * Every account holds one `entitlements` row. During the free beta every
--     row is `status='active'`, `plan='beta'`, so `is_entitled()` is true for
--     all current and future accounts and behavior is unchanged.
--   * Hosted sync is per user. Writes (create, join, redeem, both protocol
--     write paths) require an active entitlement; reads (`sync_v2_pull`,
--     `sync_v2_snapshot`, or protocol-1 SELECT) stay open to existing
--     members, so a lapsed account can always final-pull and keep working
--     locally.
--   * Rows are written only by the signup trigger, the future payment
--     webhook, and the maintainer. No client write path exists.
--   * The gate's stable server token is `CODEMAP_ENTITLEMENT_REQUIRED` with
--     SQLSTATE 42501, raised from exactly one function
--     (`public.require_sync_entitlement()`), so clients detect it before any
--     generic permission classification.
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- ── Entitlements table ─────────────────────────────────────────────────────────
-- Access is driven by `status` + `expires_at`; `plan` is the pricing-cohort
-- label ('beta' now; 'founder'/'paid' later). `expires_at` null = no expiry
-- (beta, founder-lifetime, comp).
create table if not exists public.entitlements (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  status                  text not null default 'active'
                            check (status in ('active','inactive','past_due')),
  plan                    text not null default 'beta' check (length(plan) <= 40),
  expires_at              timestamptz,
  source                  text not null default 'beta_auto' check (length(source) <= 40),
  provider                text,
  external_customer_id    text,
  external_subscription_id text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.entitlements enable row level security;

-- The table is not auto-exposed (`auto_expose_new_tables` is unset in
-- supabase/config.toml): revoke everything from every API role, then grant
-- exactly the SELect an authenticated user needs for their own row.
revoke all on table public.entitlements from public, anon, authenticated;
grant select on table public.entitlements to authenticated;

-- A user may read their own entitlement (for the client to show plan/status).
-- No insert/update/delete policy exists, so no client role can write it.
drop policy if exists entitlements_self_read on public.entitlements;
create policy entitlements_self_read on public.entitlements
  for select to authenticated using (user_id = auth.uid());

-- Server-authoritative updated_at, same pattern as the other tables.
drop trigger if exists entitlements_touch on public.entitlements;
create trigger entitlements_touch before insert or update on public.entitlements
  for each row execute function public.touch_updated_at();

-- ── Beta auto-grant (function + trigger FIRST, then backfill) ────────────────
--
-- Order matters: create the trigger before backfilling existing users so a
-- signup that races the backfill window cannot slip between the two. The
-- backfill itself uses on conflict do nothing, so pre-trigger and
-- post-trigger rows both land exactly once.
create or replace function public.grant_beta_entitlement()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.entitlements (user_id, status, plan, source)
  values (new.id, 'active', 'beta', 'beta_auto')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_grant_beta on auth.users;
create trigger on_auth_user_created_grant_beta
  after insert on auth.users
  for each row execute function public.grant_beta_entitlement();

-- Trigger functions need no direct execution grants, and must have none:
-- execution is a side effect of the trigger, not a public capability.
revoke execute on function public.grant_beta_entitlement() from public, anon, authenticated;

-- Backfill every EXISTING account as active beta, so the gate added below
-- never blocks a current user (including the Camouflaging study team).
insert into public.entitlements (user_id, status, plan, source)
select id, 'active', 'beta', 'beta_backfill' from auth.users
on conflict (user_id) do nothing;

-- ── is_entitled: the one predicate; self-only ─────────────────────────────────
--
-- Returns true only for the calling user's own row (p_user must equal
-- auth.uid()), so a caller cannot probe another member's subscription state
-- by passing their visible UUID.
create or replace function public.is_entitled(p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select p_user = auth.uid() and exists (
    select 1 from public.entitlements e
    where e.user_id = p_user
      and e.status = 'active'
      and (e.expires_at is null or e.expires_at > now())
  );
$$;

revoke execute on function public.is_entitled(uuid) from public, anon;
-- Grant to authenticated: RLS policies (the protocol-1 write gates) and the
-- server functions call it.
grant execute on function public.is_entitled(uuid) to authenticated;

-- ── require_sync_entitlement: single stable server error token ───────────────
--
-- The one place the entitlement gate raises. Every write path — RPC function
-- guards and RLS policy expressions — funnels through this, so a client can
-- detect one stable token on all of them, including direct REST policy
-- failures that never pass through a named RPC.
create or replace function public.require_sync_entitlement()
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_entitled(auth.uid()) then
    raise exception 'CODEMAP_ENTITLEMENT_REQUIRED' using errcode = '42501';
  end if;
  return true;
end;
$$;

revoke execute on function public.require_sync_entitlement() from public, anon;
grant execute on function public.require_sync_entitlement() to authenticated;

-- ── Protocol 2 write gates ─────────────────────────────────────────────────────
-- `sync_v2_record_change` is the chokepoint for every v2 mutation (apply,
-- resolve-conflict, activate backfill). The same guard is added to
-- `sync_v2_activate` itself because an EMPTY study reaches protocol 2 without
-- ever calling record_change.
create or replace function public.sync_v2_record_change(
  p_project_id text,
  p_generation uuid,
  p_op_id uuid,
  p_device_id uuid,
  p_user_id uuid,
  p_actor_key text,
  p_entity_type text,
  p_entity_id text,
  p_op_kind text,
  p_payload jsonb
)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare
  next_seq bigint;
begin
  perform public.require_sync_entitlement();
  update public.projects
     set sync_head = sync_head + 1,
         updated_at = now()
   where project_id = p_project_id
     and sync_generation = p_generation
  returning sync_head into next_seq;
  if next_seq is null then
    raise exception 'Sync generation changed while recording an operation.';
  end if;

  insert into public.sync_changes (
    project_id, generation, seq, op_id, device_id, user_id, actor_key,
    entity_type, entity_id, op_kind, payload
  ) values (
    p_project_id, p_generation, next_seq, p_op_id, p_device_id, p_user_id,
    p_actor_key, p_entity_type, p_entity_id, p_op_kind, p_payload
  );

  insert into public.sync_project_heads (project_id, generation, head_seq, updated_at)
  values (p_project_id, p_generation, next_seq, now())
  on conflict (project_id) do update
    set generation = excluded.generation,
        head_seq = excluded.head_seq,
        updated_at = excluded.updated_at;
  return next_seq;
end;
$$;

create or replace function public.sync_v2_activate(project_id text)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  p public.projects%rowtype;
  code_row public.codebook%rowtype;
  interview_row public.interviews%rowtype;
  legacy_row record;
  generation_id uuid := gen_random_uuid();
  sequence bigint;
  actor_key text;
  actor_user_id uuid;
  actor_count integer;
  legacy_actor_count integer := 0;
  edge_span_key text;
  op_uuid uuid;
begin
  perform public.sync_v2_require_admin(sync_v2_activate.project_id);
  perform public.require_sync_entitlement();
  select * into p from public.projects
   where projects.project_id = sync_v2_activate.project_id
   for update;
  if not found then
    raise exception 'Study does not exist.';
  end if;
  if p.sync_protocol <> 1 then
    raise exception 'This study has already activated Sync Protocol 2.' using errcode = '22023';
  end if;
  if exists (
    select 1
      from public.project_members m
      left join public.sync_member_readiness r
        on r.project_id = m.project_id and r.user_id = m.user_id
     where m.project_id = sync_v2_activate.project_id
       and r.ready_at is null
  ) then
    raise exception 'Every current member must install Codemap 0.27 and complete one final protocol-1 sync before activation.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.sync_devices d
     where d.project_id = sync_v2_activate.project_id
       and d.legacy_pending_count > 0
  ) then
    raise exception 'A registered device still reports unsent protocol-1 work.' using errcode = '22023';
  end if;

  lock table public.codebook, public.interviews, public.coded_segments in share row exclusive mode;
  update public.projects
     set sync_generation = generation_id,
         sync_head = 0,
         sync_activated_at = null
   where projects.project_id = sync_v2_activate.project_id;
  insert into public.sync_project_heads (project_id, generation, head_seq, updated_at)
  values (sync_v2_activate.project_id, generation_id, 0, now())
  on conflict (project_id) do update
    set generation = excluded.generation, head_seq = 0, updated_at = excluded.updated_at;

  for code_row in
    select * from public.codebook
     where codebook.project_id = sync_v2_activate.project_id
     order by id
  loop
    op_uuid := public.sync_v2_baseline_op_id('code|' || sync_v2_activate.project_id || '|' || code_row.id);
    sequence := public.sync_v2_record_change(
      sync_v2_activate.project_id, generation_id, op_uuid, null, null, 'system:baseline', 'code', code_row.id,
      'code.create', jsonb_build_object(
        'name', code_row.name, 'definition', code_row.definition,
        'inclusion_criteria', code_row.inclusion_criteria,
        'exclusion_criteria', code_row.exclusion_criteria, 'example', code_row.example,
        'parent_id', code_row.parent_id, 'color', code_row.color,
        'sort_order', code_row.sort_order, 'is_retired', code_row.is_retired,
        'deleted', code_row.deleted
      )
    );
    update public.codebook
       set field_versions = jsonb_build_object(
             'name', sequence, 'definition', sequence, 'inclusion_criteria', sequence,
             'exclusion_criteria', sequence, 'example', sequence, 'parent_id', sequence,
             'color', sequence, 'sort_order', sequence, 'is_retired', sequence, 'deleted', sequence
           ),
           tombstone_seq = case when code_row.deleted then sequence else null end
     where id = code_row.id and codebook.project_id = sync_v2_activate.project_id;
  end loop;

  for interview_row in
    select * from public.interviews
     where interviews.project_id = sync_v2_activate.project_id
     order by id
  loop
    op_uuid := public.sync_v2_baseline_op_id('interview|' || sync_v2_activate.project_id || '|' || interview_row.id);
    sequence := public.sync_v2_record_change(
      sync_v2_activate.project_id, generation_id, op_uuid, null, null, 'system:baseline', 'interview', interview_row.id,
      'interview.patch', jsonb_build_object('patch', jsonb_build_object(
        'study_label', interview_row.study_label, 'segment_count', interview_row.segment_count,
        'content_hash', interview_row.content_hash, 'deleted', interview_row.deleted
      ))
    );
    update public.interviews
       set field_versions = jsonb_build_object(
             'study_label', sequence, 'segment_count', sequence,
             'content_hash', sequence, 'deleted', sequence
           ),
           tombstone_seq = case when interview_row.deleted then sequence else null end
     where id = interview_row.id and interviews.project_id = sync_v2_activate.project_id;
  end loop;

  for legacy_row in
    select cs.interview_id, cs.segment_id, cs.coder_name, cs.char_start, cs.char_end, cs.span_key,
           code_id
      from public.coded_segments cs
      cross join lateral unnest(cs.code_ids) code_id
      join public.codebook b on b.id = code_id and b.project_id = cs.project_id
     where cs.project_id = sync_v2_activate.project_id
       and not cs.deleted
       and not b.deleted
     order by cs.interview_id, cs.segment_id, cs.coder_name, cs.span_key, code_id
  loop
    select count(*), min(m.user_id::text)::uuid into actor_count, actor_user_id
      from public.project_members m
     where m.project_id = sync_v2_activate.project_id
       and lower(m.coder_name) = lower(legacy_row.coder_name);
    if actor_count = 1 then
      actor_key := 'user:' || actor_user_id::text;
    else
      actor_key := 'legacy:' || encode(extensions.digest((sync_v2_activate.project_id || '|' || lower(legacy_row.coder_name))::bytea, 'sha256'), 'hex');
      legacy_actor_count := legacy_actor_count + 1;
    end if;
    edge_span_key := coalesce(legacy_row.char_start::text, '*') || ':' || coalesce(legacy_row.char_end::text, '*');
    op_uuid := public.sync_v2_baseline_op_id(
      'coding|' || sync_v2_activate.project_id || '|' || legacy_row.interview_id || '|' || legacy_row.segment_id ||
      '|' || actor_key || '|' || edge_span_key || '|' || legacy_row.code_id
    );
    sequence := public.sync_v2_record_change(
      sync_v2_activate.project_id, generation_id, op_uuid, null, null, actor_key, 'coding',
      legacy_row.interview_id || ':' || legacy_row.segment_id || ':' || edge_span_key,
      'coding.patch', jsonb_build_object('adds', jsonb_build_array(jsonb_build_object(
        'interview_id', legacy_row.interview_id, 'segment_id', legacy_row.segment_id,
        'code_id', legacy_row.code_id, 'char_start', legacy_row.char_start,
        'char_end', legacy_row.char_end
      )), 'removes', '[]'::jsonb)
    );
    insert into public.coding_assignments (
      project_id, interview_id, segment_id, actor_key, span_key, code_id,
      char_start, char_end, present, version_seq, updated_at
    ) values (
      sync_v2_activate.project_id, legacy_row.interview_id, legacy_row.segment_id, actor_key,
      edge_span_key, legacy_row.code_id, legacy_row.char_start, legacy_row.char_end,
      true, sequence, now()
    ) on conflict (project_id, interview_id, segment_id, actor_key, span_key, code_id) do update
      set present = true, version_seq = excluded.version_seq, updated_at = excluded.updated_at;
  end loop;

  update public.projects
     set sync_protocol = 2,
         sync_activated_at = now()
   where projects.project_id = sync_v2_activate.project_id;
  update public.sync_member_readiness
     set ready_generation = generation_id
   where sync_member_readiness.project_id = sync_v2_activate.project_id;
  select * into p from public.projects where projects.project_id = sync_v2_activate.project_id;
  return jsonb_build_object(
    'protocol', p.sync_protocol, 'generation', generation_id, 'head', p.sync_head,
    'legacy_actor_rows', legacy_actor_count
  );
end;
$$;

-- Re-issue the exact privileges both functions carry in the schema-10
-- migration (clients reach them only through sync_v2_apply/proxies; here we
-- re-state them because create or replace resets defaults for revoke-list
-- cleanliness — harmless, but explicit beats implicit).
revoke all on function public.sync_v2_record_change(text, uuid, uuid, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.sync_v2_activate(text) from public, anon;
grant execute on function public.sync_v2_activate(text) to authenticated;

-- ── Current and legacy join plus create ───────────────────────────────────────
-- The shipping client joins via `join_group`; `redeem_invite` remains for
-- legacy compatibility. Both are membership writes, so both are gated. The
-- create path is a direct REST insert, gated through the RLS policy below.
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
  perform public.require_sync_entitlement();

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
  perform public.require_sync_entitlement();

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

revoke execute on function redeem_invite(text) from anon, public;
grant execute on function redeem_invite(text) to authenticated;

-- Creating is a direct REST insert; the with-check raises the stable
-- entitlement token when a non-entitled caller tries, rather than collapsing
-- into PostgREST's generic RLS error.
drop policy if exists projects_create on public.projects;
create policy projects_create on public.projects
  for insert to authenticated
  with check (public.require_sync_entitlement());

-- ── Close the Protocol-1 write bypass while preserving reads ─────────────────
-- While a study is not yet protocol 2, clients write `codebook`, `interviews`
-- and `coded_segments` directly under RLS. The schema-10 migration left them
-- as `for all` policies gated only by membership + protocol 1 — a write
-- bypass for a not-all-ready (unpaid) legacy study. Split each into separate
-- read (no entitlement) and entitled mutation policies. Do not alter protocol
-- 2 read RPCs or read policies.

drop policy if exists codebook_rw on public.codebook;
drop policy if exists codebook_v1_read on public.codebook;
drop policy if exists codebook_v1_insert on public.codebook;
drop policy if exists codebook_v1_update on public.codebook;
drop policy if exists codebook_v1_delete on public.codebook;
create policy codebook_v1_read on public.codebook
  for select using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = codebook.project_id and p.sync_protocol = 1)
  );
create policy codebook_v1_insert on public.codebook
  for insert to authenticated with check (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = codebook.project_id and p.sync_protocol = 1)
    and public.require_sync_entitlement()
  );
create policy codebook_v1_update on public.codebook
  for update to authenticated using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = codebook.project_id and p.sync_protocol = 1)
  ) with check (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = codebook.project_id and p.sync_protocol = 1)
    and public.require_sync_entitlement()
  );
create policy codebook_v1_delete on public.codebook
  for delete to authenticated using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = codebook.project_id and p.sync_protocol = 1)
    and public.require_sync_entitlement()
  );

drop policy if exists interviews_rw on public.interviews;
drop policy if exists interviews_v1_read on public.interviews;
drop policy if exists interviews_v1_insert on public.interviews;
drop policy if exists interviews_v1_update on public.interviews;
drop policy if exists interviews_v1_delete on public.interviews;
create policy interviews_v1_read on public.interviews
  for select using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = interviews.project_id and p.sync_protocol = 1)
  );
create policy interviews_v1_insert on public.interviews
  for insert to authenticated with check (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = interviews.project_id and p.sync_protocol = 1)
    and public.require_sync_entitlement()
  );
create policy interviews_v1_update on public.interviews
  for update to authenticated using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = interviews.project_id and p.sync_protocol = 1)
  ) with check (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = interviews.project_id and p.sync_protocol = 1)
    and public.require_sync_entitlement()
  );
create policy interviews_v1_delete on public.interviews
  for delete to authenticated using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = interviews.project_id and p.sync_protocol = 1)
    and public.require_sync_entitlement()
  );

drop policy if exists coded_segments_rw on public.coded_segments;
drop policy if exists coded_segments_v1_read on public.coded_segments;
drop policy if exists coded_segments_v1_insert on public.coded_segments;
drop policy if exists coded_segments_v1_update on public.coded_segments;
drop policy if exists coded_segments_v1_delete on public.coded_segments;
create policy coded_segments_v1_read on public.coded_segments
  for select using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = coded_segments.project_id and p.sync_protocol = 1)
  );
create policy coded_segments_v1_insert on public.coded_segments
  for insert to authenticated with check (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = coded_segments.project_id and p.sync_protocol = 1)
    and public.require_sync_entitlement()
  );
create policy coded_segments_v1_update on public.coded_segments
  for update to authenticated using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = coded_segments.project_id and p.sync_protocol = 1)
  ) with check (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = coded_segments.project_id and p.sync_protocol = 1)
    and public.require_sync_entitlement()
  );
create policy coded_segments_v1_delete on public.coded_segments
  for delete to authenticated using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = coded_segments.project_id and p.sync_protocol = 1)
    and public.require_sync_entitlement()
  );

notify pgrst, 'reload schema';
commit;
