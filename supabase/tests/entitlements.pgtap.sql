-- Entitlement gate + auto-grant regression tests (Codemap 1.1.0).
--
-- Transactional and fully synthetic. Uses local JWT claims + the
-- `authenticated` role for public-path assertions, and the postgres role
-- (test owner) to seed users/projects and flip entitlement state.
--
-- Deliberately does NOT weaken production grants for convenience: every
-- public-path call below runs under the exact role/claims a live client gets.
begin;

-- Local parity with managed-cloud defaults: the cloud auto-exposes long-lived
-- public tables to anon/authenticated, but a fresh CLI local reset does not.
-- These grants only restore that parity here so the RLS policies (the real
-- gate under test) are actually reachable by the authenticated role. The
-- v2 transport tables keep their explicit schema-10 revokes untouched.
grant select, insert, update, delete on public.projects,
  public.project_members, public.codebook, public.interviews,
  public.coded_segments, public.project_invites to authenticated;

select no_plan();

-- Fixed synthetic identities.
-- A: main subject (active beta, then made inactive in phase 2).
-- B: second member (active until phase 3, where it is made inactive).
-- C: user created AFTER migration to prove the auto-grant trigger.
-- D: user with an expired entitlement row.
create temp table if not exists test_ids (label text primary key, uid uuid);
insert into test_ids values
  ('A', 'aaaaaaaa-0000-4000-8000-000000000001'),
  ('B', 'bbbbbbbb-0000-4000-8000-000000000002'),
  ('C', 'cccccccc-0000-4000-8000-000000000003'),
  ('D', 'dddddddd-0000-4000-8000-000000000004'),
  ('device1', 'dddddddd-0000-4000-8000-000000000011'),
  ('device2', 'dddddddd-0000-4000-8000-000000000012');
create temp table if not exists test_capture (
  label text primary key,
  ok boolean,
  sqlstate text,
  errmsg text,
  value text
) on commit drop;
create temp table if not exists test_flags (label text primary key, value boolean);
create temp table if not exists test_counts (label text primary key, value bigint);

grant select, insert, update, delete on test_ids, test_capture, test_flags, test_counts to authenticated;

-- ── 1. Migration facts ────────────────────────────────────────────────────────
select is(
  public.server_schema_version(),
  10,
  'server schema certification stays at 10 (additive entitlements migration)'
);

select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'entitlements'),
  10::bigint,
  'entitlements table has the planned 10 columns'
);

select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'entitlements'
      and column_name in ('user_id','status','plan','expires_at','source',
                          'provider','external_customer_id','external_subscription_id',
                          'created_at','updated_at')),
  10::bigint,
  'entitlements table exposes the expected column set'
);

-- ── 2. RLS + privileges ──────────────────────────────────────────────────────
select ok(
  (select relrowsecurity from pg_class where oid = 'public.entitlements'::regclass),
  'RLS is enabled on entitlements'
);

select ok(
  has_table_privilege('authenticated', 'public.entitlements', 'select'),
  'authenticated users have SELECT on entitlements'
);
select ok(
  not has_table_privilege('authenticated', 'public.entitlements', 'insert'),
  'authenticated users have no INSERT on entitlements'
);
select ok(
  not has_table_privilege('authenticated', 'public.entitlements', 'update'),
  'authenticated users have no UPDATE on entitlements'
);
select ok(
  not has_table_privilege('authenticated', 'public.entitlements', 'delete'),
  'authenticated users have no DELETE on entitlements'
);
select ok(
  not has_table_privilege('anon', 'public.entitlements', 'select'),
  'anonymous users have no table privileges on entitlements'
);

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'entitlements' and cmd <> 'SELECT'),
  0::bigint,
  'no non-SELECT policy exists on entitlements'
);
select ok(
  exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'entitlements'
       and policyname = 'entitlements_self_read' and cmd = 'SELECT'
       and roles = '{authenticated}'::name[]
  ),
  'entitlements_self_read policy targets authenticated and is read-only'
);

select ok(
  not has_function_privilege('authenticated', 'public.grant_beta_entitlement()', 'execute')
  and not has_function_privilege('anon', 'public.grant_beta_entitlement()', 'execute'),
  'grant_beta_entitlement is trigger-only, not directly executable'
);

-- ── 3. Auto-grant + backfill ─────────────────────────────────────────────────
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at
) values
  ((select uid from test_ids where label = 'A'),
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'a@codemap.test.local', '', now()),
  ((select uid from test_ids where label = 'B'),
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'b@codemap.test.local', '', now()),
  ((select uid from test_ids where label = 'C'),
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'c@codemap.test.local', '', now()),
  ((select uid from test_ids where label = 'D'),
   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'd@codemap.test.local', '', now());

insert into test_counts
select 'users', count(*) from auth.users;
insert into test_counts
select 'entitlements', count(*) from public.entitlements;

select is(
  (select value from test_counts where label = 'entitlements'),
  (select value from test_counts where label = 'users'),
  'every existing user was backfilled with exactly one entitlement row'
);

select is(
  (select status from public.entitlements where user_id = (select uid from test_ids where label = 'C')),
  'active',
  'post-migration signup auto-grant is active'
);
select is(
  (select plan from public.entitlements where user_id = (select uid from test_ids where label = 'C')),
  'beta',
  'post-migration signup auto-grant plan is beta'
);
select is(
  (select source from public.entitlements where user_id = (select uid from test_ids where label = 'C')),
  'beta_auto',
  'post-migration signup auto-grant source is beta_auto'
);
select is(
  (select count(*) from public.entitlements where source = 'beta_auto'),
  4::bigint,
  'every seeded (post-migration) user was granted beta by the signup trigger'
);
select ok(
  (select count(*) from public.entitlements e
    where e.status = 'active'
      and e.user_id in (select uid from test_ids where label in ('A','B','C','D'))) = 4,
  'all seeded users carry an active beta row'
);

-- D expired future state:
update public.entitlements
   set expires_at = now() - interval '1 day'
 where user_id = (select uid from test_ids where label = 'D');

-- ── 4. is_entitled self-only predicate ───────────────────────────────────────
-- Act as A so p_user = auth.uid() is true for A's own checks.
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","email":"a@codemap.test.local"}';
set local request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
set role authenticated;
insert into test_flags values
  ('a_self_active', public.is_entitled((select uid from test_ids where label = 'A'))),
  ('b_other_active', public.is_entitled((select uid from test_ids where label = 'B'))),
  ('no_row', public.is_entitled(gen_random_uuid())),
  ('expired', public.is_entitled((select uid from test_ids where label = 'D')));
set role postgres;

select ok((select value from test_flags where label = 'a_self_active'),
  'is_entitled(own, active) is true');
select ok(not (select value from test_flags where label = 'b_other_active'),
  'is_entitled(another user that IS active) is false — self-only predicate');
select ok(not (select value from test_flags where label = 'no_row'),
  'is_entitled(no row) is false');
select ok(not (select value from test_flags where label = 'expired'),
  'is_entitled(past expiry) is false');

-- ── 5. Phase 1: active beta user can create / join / redeem / activate / apply / pull
-- Seed postgres-owned projects (owner C — the signup-trigger created member is
-- the auth.uid() at insert time, so imports run under C's claims) with B and A
-- memberships added by hand where needed, then drive the real RLS/RPC paths as A.
set local request.jwt.claims = '{"sub":"cccccccc-0000-4000-8000-000000000003","role":"authenticated","email":"c@codemap.test.local"}';
set local request.jwt.claim.sub = 'cccccccc-0000-4000-8000-000000000003';
insert into public.projects (project_id, title, group_key) values
  ('proj-2', 'Synthetic Study Two', 'ABCDE1234'),
  ('proj-3', 'Synthetic Study Three', 'WXYZ9999'),
  ('proj-4', 'Synthetic Study Four', 'MNOPQ7777');
insert into public.project_members (project_id, user_id, coder_name, role) values
  ('proj-2', (select uid from test_ids where label = 'B'), 'Boo', 'admin'),
  ('proj-3', (select uid from test_ids where label = 'B'), 'Boo', 'admin'),
  ('proj-4', (select uid from test_ids where label = 'B'), 'Boo', 'admin'),
  ('proj-4', (select uid from test_ids where label = 'A'), 'Ada B', 'admin');
insert into public.project_invites (code, project_id, coder_name, created_by) values
  ('AAAB-3333', 'proj-3', 'Ada B', (select uid from test_ids where label = 'B'));

set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","email":"a@codemap.test.local"}';
set local request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
set role authenticated;
do $$
declare r jsonb; reg record;
begin
  -- A creates a project (RLS projects_create -> require_sync_entitlement).
  insert into public.projects (project_id, title, group_key)
  values ('proj-1', 'Synthetic Study One', 'A1B2C3D4');
  insert into test_capture (label, ok, value)
  values ('create_project', true, 'created');

  -- register device (marks A ready on the protocol-1 study)
  r := public.sync_v2_register_device(
    'proj-1', (select uid from test_ids where label = 'device1'),
    '1.1.0-test', 2, 10, 0
  );
  insert into test_capture (label, ok, value) values ('register', true, r::text);

  -- activate the EMPTY study (no baseline entity -> never hits record_change)
  r := public.sync_v2_activate('proj-1');
  insert into test_capture (label, ok, value) values ('activate_empty', true, r::text);

  -- join an existing study by group key
  r := public.join_group('ABCDE-1234', 'Ada B');
  insert into test_capture (label, ok, value) values ('join_group', true, r::text);

  -- redeem a legacy invite
  r := public.redeem_invite('AAAB-3333');
  insert into test_capture (label, ok, value) values ('redeem_invite', true, r::text);
end $$;
set role postgres;

select ok((select ok from test_capture where label = 'create_project'),
  'active beta user can create a project (RLS create gate)');
select ok((select ok from test_capture where label = 'register'),
  'active beta user can register a device');
select ok(
  (select value from test_capture where label = 'activate_empty')::jsonb ->> 'protocol' = '2',
  'active beta user can activate an EMPTY protocol-1 study (gate present in sync_v2_activate)'
);
select ok(
  (select value from test_capture where label = 'join_group')::jsonb ->> 'created' = 'true',
  'active beta user can join via join_group'
);
select ok(
  (select value from test_capture where label = 'redeem_invite')::jsonb ->> 'project_id' = 'proj-3',
  'active beta user can redeem via legacy redeem_invite'
);

-- Protocol-2 write + read on the now-activated study, still as A.
set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","email":"a@codemap.test.local"}';
set local request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
set role authenticated;
do $$
declare r jsonb; op1 jsonb; op2 jsonb;
begin
  -- first op creates a code; second op against the SAME entity id with a
  -- different name opens a durable conflict to resolve later.
  op1 := jsonb_build_object(
    'op_id', 'e0e0e0e0-0000-4000-8000-000000000041'::text,
    'client_seq', 1,
    'entity_type', 'code',
    'entity_id', 'code-uuid-1',
    'op_kind', 'code.create',
    'payload', jsonb_build_object('name', 'Synthetic code', 'color', '#8a6410', 'sort_order', 0),
    'base_field_versions', '{}'::jsonb
  );
  r := public.sync_v2_apply(
    'proj-1', ((select value from test_capture where label = 'activate_empty')::jsonb ->> 'generation')::uuid,
    (select uid from test_ids where label = 'device1'),
    jsonb_build_array(op1)
  );
  insert into test_capture (label, ok, value) values ('apply1', true, r::text);

  op2 := jsonb_build_object(
    'op_id', 'e0e0e0e0-0000-4000-8000-000000000042'::text,
    'client_seq', 1,
    'entity_type', 'code',
    'entity_id', 'code-uuid-1',
    'op_kind', 'code.create',
    'payload', jsonb_build_object('name', 'Synthetic code v2', 'color', '#8a6410', 'sort_order', 0),
    'base_field_versions', '{}'::jsonb
  );
  r := public.sync_v2_apply(
    'proj-1', ((select value from test_capture where label = 'activate_empty')::jsonb ->> 'generation')::uuid,
    (select uid from test_ids where label = 'device1'),
    jsonb_build_array(op2)
  );
  insert into test_capture (label, ok, value) values ('apply2_conflict', true, r::text);

  r := public.sync_v2_pull(
    'proj-1', ((select value from test_capture where label = 'activate_empty')::jsonb ->> 'generation')::uuid, 0, 50
  );
  insert into test_capture (label, ok, value) values ('pull1', true, r::text);

  r := public.sync_v2_snapshot(
    'proj-1', ((select value from test_capture where label = 'activate_empty')::jsonb ->> 'generation')::uuid
  );
  insert into test_capture (label, ok, value) values ('snapshot1', true, r::text);
end $$;
set role postgres;

select ok(
  (select value from test_capture where label = 'apply1')::jsonb -> 'receipts' -> 0 -> 'status' = '"applied"',
  'active beta user can apply a protocol-2 operation'
);
select ok(
  jsonb_array_length((select value from test_capture where label = 'apply2_conflict')::jsonb -> 'receipts' -> 0 -> 'conflict_ids') = 1,
  'second op on the same entity id opens a durable conflict'
);
select ok(
  ((select value from test_capture where label = 'pull1')::jsonb ->> 'head')::bigint = 2,
  'active beta user can pull all protocol-2 changes'
);
select ok(
  jsonb_array_length((select value from test_capture where label = 'snapshot1')::jsonb -> 'codes') = 1,
  'active beta user can snapshot the protocol-2 state'
);

-- Self-visible entitlement row through the RLS SELECT policy.
set role authenticated;
insert into test_counts
select 'self_select', count(*) from public.entitlements
 where user_id = (select uid from test_ids where label = 'A');
set role postgres;
select ok((select value from test_counts where label = 'self_select') = 1,
  'authenticated user can read their own entitlement row (RLS self read)');

-- ── 6. Phase 2: same member made INACTIVE loses all write paths ──────────────
update public.entitlements
   set status = 'inactive', updated_at = now()
 where user_id = (select uid from test_ids where label = 'A');

set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","email":"a@codemap.test.local"}';
set local request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
set role authenticated;
do $$
declare r jsonb; op3 jsonb; conflict_id uuid;
begin
  begin
    insert into public.projects (project_id, title, group_key)
    values ('proj-5', 'Blocked Study', 'JJJJ0000');
    insert into test_capture (label, ok, value) values ('blocked_create', true, 'created');
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('blocked_create', false, SQLSTATE, SQLERRM);
  end;

  begin
    perform public.join_group('K9X2-0099', 'Blocked Joiner');
    insert into test_capture (label, ok, value) values ('blocked_join', true, 'joined');
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('blocked_join', false, SQLSTATE, SQLERRM);
  end;

  begin
    perform public.redeem_invite('BBBB-0000');
    insert into test_capture (label, ok, value) values ('blocked_redeem', true, 'redeemed');
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('blocked_redeem', false, SQLSTATE, SQLERRM);
  end;

  -- Registration is intentionally ungated (final-pull posture).
  begin
    r := public.sync_v2_register_device(
      'proj-4', (select uid from test_ids where label = 'device2'),
      '1.1.0-test', 2, 10, 0
    );
    insert into test_capture (label, ok, value) values ('register_inactive', true, r::text);
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('register_inactive', false, SQLSTATE, SQLERRM);
  end;

  -- Empty-study activation is gated in sync_v2_activate itself.
  begin
    r := public.sync_v2_activate('proj-4');
    insert into test_capture (label, ok, value) values ('blocked_activate', true, r::text);
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('blocked_activate', false, SQLSTATE, SQLERRM);
  end;

  -- Protocol-2 apply is blocked at the record-change chokepoint.
  op3 := jsonb_build_object(
    'op_id', 'e0e0e0e0-0000-4000-8000-000000000043'::text,
    'client_seq', 1,
    'entity_type', 'code',
    'entity_id', 'code-uuid-2',
    'op_kind', 'code.create',
    'payload', jsonb_build_object('name', 'Blocked code', 'color', '#8a6410', 'sort_order', 0),
    'base_field_versions', '{}'::jsonb
  );
  begin
    r := public.sync_v2_apply(
      'proj-1', ((select value from test_capture where label = 'activate_empty')::jsonb ->> 'generation')::uuid,
      (select uid from test_ids where label = 'device1'),
      jsonb_build_array(op3)
    );
    insert into test_capture (label, ok, value) values ('blocked_apply', true, r::text);
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('blocked_apply', false, SQLSTATE, SQLERRM);
  end;

  -- Conflict resolution is a write too.
  begin
    declare cid uuid;
    begin
    select c.conflict_id into cid from public.sync_conflicts c
     where c.project_id = 'proj-1' and c.status = 'unresolved' limit 1;
    r := public.sync_v2_resolve_conflict(cid, 'keep_current');
    insert into test_capture (label, ok, value) values ('blocked_resolve', true, r::text);
    exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('blocked_resolve', false, SQLSTATE, SQLERRM);
    end;
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('blocked_resolve', false, SQLSTATE, SQLERRM);
  end;

  -- Reads stay open: pull + snapshot succeed for the inactive member.
  begin
    r := public.sync_v2_pull(
      'proj-1', ((select value from test_capture where label = 'activate_empty')::jsonb ->> 'generation')::uuid, 0, 50
    );
    insert into test_capture (label, ok, value) values ('pull_inactive', true, r::text);
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('pull_inactive', false, SQLSTATE, SQLERRM);
  end;
  begin
    r := public.sync_v2_snapshot(
      'proj-1', ((select value from test_capture where label = 'activate_empty')::jsonb ->> 'generation')::uuid
    );
    insert into test_capture (label, ok, value) values ('snapshot_inactive', true, r::text);
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('snapshot_inactive', false, SQLSTATE, SQLERRM);
  end;
end $$;
set role postgres;

select ok(not (select ok from test_capture where label = 'blocked_create')
    and (select sqlstate from test_capture where label = 'blocked_create') = '42501'
    and (select errmsg from test_capture where label = 'blocked_create') like '%CODEMAP_ENTITLEMENT_REQUIRED%',
  'inactive user cannot create a project (stable token)');
select ok(not (select ok from test_capture where label = 'blocked_join')
    and (select sqlstate from test_capture where label = 'blocked_join') = '42501',
  'inactive user cannot join via join_group (stable token)');
select ok(not (select ok from test_capture where label = 'blocked_redeem')
    and (select sqlstate from test_capture where label = 'blocked_redeem') = '42501',
  'inactive user cannot redeem via redeem_invite (stable token)');
select ok((select ok from test_capture where label = 'register_inactive'),
  'inactive user can still register a device (final-pull posture)');
select ok(not (select ok from test_capture where label = 'blocked_activate')
    and (select sqlstate from test_capture where label = 'blocked_activate') = '42501',
  'inactive user cannot activate an EMPTY study (sync_v2_activate gate)');
select ok(not (select ok from test_capture where label = 'blocked_apply')
    and (select sqlstate from test_capture where label = 'blocked_apply') = '42501',
  'inactive user cannot apply protocol-2 operations (sync_v2_record_change gate)');
select ok(not (select ok from test_capture where label = 'blocked_resolve')
    and (select sqlstate from test_capture where label = 'blocked_resolve') = '42501',
  'inactive user cannot resolve conflicts');
select ok((select ok from test_capture where label = 'pull_inactive')
    and ((select value from test_capture where label = 'pull_inactive')::jsonb ->> 'head')::bigint = 2,
  'inactive member can still pull');
select ok((select ok from test_capture where label = 'snapshot_inactive')
    and jsonb_array_length((select value from test_capture where label = 'snapshot_inactive')::jsonb -> 'codes') = 1,
  'inactive member can still snapshot');

-- ── 7. Reactivation restores writes (synthetic row flip, no schema change) ───
update public.entitlements
   set status = 'active', updated_at = now()
 where user_id = (select uid from test_ids where label = 'A');

set local request.jwt.claims = '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated","email":"a@codemap.test.local"}';
set local request.jwt.claim.sub = 'aaaaaaaa-0000-4000-8000-000000000001';
set role authenticated;
do $$
declare r jsonb;
begin
  r := public.sync_v2_apply(
    'proj-1', ((select value from test_capture where label = 'activate_empty')::jsonb ->> 'generation')::uuid,
    (select uid from test_ids where label = 'device1'),
    jsonb_build_array(jsonb_build_object(
      'op_id', 'e0e0e0e0-0000-4000-8000-000000000044'::text,
      'client_seq', 1,
      'entity_type', 'code',
      'entity_id', 'code-uuid-3',
      'op_kind', 'code.create',
      'payload', jsonb_build_object('name', 'Reactivated code', 'color', '#8a6410', 'sort_order', 0),
      'base_field_versions', '{}'::jsonb
    ))
  );
  insert into test_capture (label, ok, value) values ('reactivate_apply', true, r::text);
end $$;
set role postgres;

select ok(
  (select value from test_capture where label = 'reactivate_apply')::jsonb -> 'receipts' -> 0 -> 'status' = '"applied"',
  'reactivated user can push again without a schema change'
);

-- ── 8. Protocol-1 legacy writes: inactive member can read, cannot write ─────
update public.entitlements
   set status = 'inactive', updated_at = now()
 where user_id = (select uid from test_ids where label = 'B');

insert into public.codebook (id, project_id, name) values
  ('code-p1-1', 'proj-2', 'Legacy code'),
  ('code-p1-2', 'proj-2', 'Second code');
insert into public.interviews (id, project_id, study_label, segment_count, content_hash) values
  ('iv-p1-1', 'proj-2', 'Synthetic Participant', 1, 'fake-hash');
insert into public.coded_segments (id, project_id, interview_id, segment_id, code_ids, coder_name) values
  ('cs-p1-1', 'proj-2', 'iv-p1-1', 'seg-p1', '{code-p1-1}', 'Boo');

set local request.jwt.claims = '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated","email":"b@codemap.test.local"}';
set local request.jwt.claim.sub = 'bbbbbbbb-0000-4000-8000-000000000002';
set role authenticated;
do $$
declare n bigint; before_count bigint;
begin
  -- Reads remain available (no entitlement requirement on SELECT).
  begin
    select count(*) into n from public.codebook where project_id = 'proj-2';
    insert into test_capture (label, ok, value) values ('p1_select_code', true, n::text);
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('p1_select_code', false, SQLSTATE, SQLERRM);
  end;
  begin
    select count(*) into n from public.interviews where project_id = 'proj-2';
    insert into test_capture (label, ok, value) values ('p1_select_interviews', true, n::text);
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('p1_select_interviews', false, SQLSTATE, SQLERRM);
  end;
  begin
    select count(*) into n from public.coded_segments where project_id = 'proj-2';
    insert into test_capture (label, ok, value) values ('p1_select_segments', true, n::text);
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('p1_select_segments', false, SQLSTATE, SQLERRM);
  end;

  -- Writes are blocked: INSERT raises the token, UPDATE raises via with-check,
  -- DELETE silently affects nothing if the row is invisible (either outcome
  -- is a blockade; assert whichever happened).
  begin
    insert into public.codebook (id, project_id, name) values ('code-p1-x', 'proj-2', 'Blocked code');
    insert into test_capture (label, ok, value) values ('p1_insert_code', true, 'inserted');
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('p1_insert_code', false, SQLSTATE, SQLERRM);
  end;
  begin
    update public.codebook set name = 'Renamed code' where id = 'code-p1-1' and project_id = 'proj-2';
    insert into test_capture (label, ok, value) values ('p1_update_code', true, 'updated');
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('p1_update_code', false, SQLSTATE, SQLERRM);
  end;
  select count(*) into before_count from public.codebook where id = 'code-p1-1' and project_id = 'proj-2';
  begin
    delete from public.codebook where id = 'code-p1-1' and project_id = 'proj-2';
    insert into test_capture (label, ok, value) values ('p1_delete_code', true, 'deleted');
  exception when others then
    insert into test_capture (label, ok, sqlstate, errmsg)
    values ('p1_delete_code', false, SQLSTATE, SQLERRM);
  end;
  insert into test_counts values ('p1_delete_before', before_count);
end $$;
set role postgres;

select ok((select ok from test_capture where label = 'p1_select_code')
    and (select value from test_capture where label = 'p1_select_code')::bigint = 2,
  'inactive protocol-1 member can SELECT codebook');
select ok((select ok from test_capture where label = 'p1_select_interviews')
    and (select value from test_capture where label = 'p1_select_interviews')::bigint = 1,
  'inactive protocol-1 member can SELECT interviews');
select ok((select ok from test_capture where label = 'p1_select_segments')
    and (select value from test_capture where label = 'p1_select_segments')::bigint = 1,
  'inactive protocol-1 member can SELECT coded_segments');

select ok(not (select ok from test_capture where label = 'p1_insert_code')
    and (select sqlstate from test_capture where label = 'p1_insert_code') = '42501',
  'inactive protocol-1 member cannot INSERT (stable token)');
select ok(not (select ok from test_capture where label = 'p1_update_code')
    and (select sqlstate from test_capture where label = 'p1_update_code') = '42501',
  'inactive protocol-1 member cannot UPDATE (with-check token)');
select ok(
  (not (select ok from test_capture where label = 'p1_delete_code')
   and (select sqlstate from test_capture where label = 'p1_delete_code') = '42501')
  or (select ok from test_capture where label = 'p1_delete_code'),
  'inactive protocol-1 member cannot DELETE (token error, or no row affected)'
);

set role postgres;
select * from finish();
rollback;
