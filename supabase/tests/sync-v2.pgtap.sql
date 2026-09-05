begin;

select no_plan();

select is(
  public.server_schema_version(),
  10,
  'the local migration certifies schema version 10'
);

select ok(
  not has_table_privilege('authenticated', 'public.sync_changes', 'insert'),
  'authenticated clients cannot directly insert operation-log rows'
);

select ok(
  not has_table_privilege('authenticated', 'public.sync_conflicts', 'insert'),
  'authenticated clients cannot directly insert conflict rows'
);

select ok(
  not has_table_privilege('authenticated', 'public.coding_assignments', 'insert'),
  'authenticated clients cannot directly insert assignments'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.sync_v2_apply(text,uuid,uuid,jsonb)',
    'execute'
  ),
  'authenticated clients can use the v2 apply RPC'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.sync_v2_apply(text,uuid,uuid,jsonb)',
    'execute'
  ),
  'anonymous clients cannot use the v2 apply RPC'
);

select ok(
  public.sync_v2_payload_is_allowed(
    'code.create',
    '{"name":"Synthetic code","color":"#8a6410","sort_order":0}'::jsonb
  ),
  'a canonical code-create payload is accepted'
);

select ok(
  not public.sync_v2_payload_is_allowed(
    'code.create',
    '{"name":"Synthetic code","memo":"forbidden"}'::jsonb
  ),
  'a local-only memo key is rejected by the server allowlist'
);

select ok(
  not public.sync_v2_payload_is_allowed(
    'coding.patch',
    '{"adds":[{"interview_id":"interview","segment_id":"segment","code_id":"code","transcript":"forbidden"}],"removes":[]}'::jsonb
  ),
  'a nested transcript key is rejected by the server allowlist'
);

select ok(
  not public.sync_v2_payload_is_allowed(
    'code.patch',
    '{"patch":{"unknown":"forbidden"}}'::jsonb
  ),
  'unknown patch fields are rejected'
);

select is(
  (
    select count(*)::integer
      from information_schema.columns
     where table_schema = 'public'
       and table_name in ('sync_changes', 'sync_conflicts', 'coding_assignments')
       and column_name in ('memo', 'transcript', 'segment_text', 'quote_text', 'audio_path', 'raw_vtt_path', 'path')
  ),
  0,
  'v2 transport tables have no forbidden local-content columns'
);

-- ── Null spans validator cases (t02) ──────────────────────────────────────────
select ok(
  public.sync_v2_payload_is_allowed(
    'coding.patch',
    '{"adds":[{"interview_id":"iv1","segment_id":"seg1","code_id":"c1"}],"removes":[]}'::jsonb
  ),
  'whole-turn coding with omitted span keys is allowed'
);

select ok(
  public.sync_v2_payload_is_allowed(
    'coding.patch',
    '{"adds":[{"interview_id":"iv1","segment_id":"seg1","code_id":"c1","char_start":null,"char_end":null}],"removes":[]}'::jsonb
  ),
  'whole-turn coding with 2.4.x explicit null/null span keys is allowed'
);

select ok(
  public.sync_v2_payload_is_allowed(
    'coding.patch',
    '{"adds":[{"interview_id":"iv1","segment_id":"seg1","code_id":"c1","char_start":0,"char_end":10}],"removes":[]}'::jsonb
  ),
  'span coding with valid numeric keys is allowed'
);

select ok(
  not public.sync_v2_payload_is_allowed(
    'coding.patch',
    '{"adds":[{"interview_id":"iv1","segment_id":"seg1","code_id":"c1","char_start":0}],"removes":[]}'::jsonb
  ),
  'missing char_end is rejected'
);

select ok(
  not public.sync_v2_payload_is_allowed(
    'coding.patch',
    '{"adds":[{"interview_id":"iv1","segment_id":"seg1","code_id":"c1","char_end":10}],"removes":[]}'::jsonb
  ),
  'missing char_start is rejected'
);

select ok(
  not public.sync_v2_payload_is_allowed(
    'coding.patch',
    '{"adds":[{"interview_id":"iv1","segment_id":"seg1","code_id":"c1","char_start":null,"char_end":10}],"removes":[]}'::jsonb
  ),
  'mixed null/number is rejected'
);

select ok(
  not public.sync_v2_payload_is_allowed(
    'coding.patch',
    '{"adds":[{"interview_id":"iv1","segment_id":"seg1","code_id":"c1","char_start":10,"char_end":null}],"removes":[]}'::jsonb
  ),
  'mixed number/null is rejected'
);

select ok(
  not public.sync_v2_payload_is_allowed(
    'coding.patch',
    '{"adds":[{"interview_id":"iv1","segment_id":"seg1","code_id":"c1","char_start":-1,"char_end":10}],"removes":[]}'::jsonb
  ),
  'negative char_start is rejected'
);

select ok(
  not public.sync_v2_payload_is_allowed(
    'coding.patch',
    '{"adds":[{"interview_id":"iv1","segment_id":"seg1","code_id":"c1","char_start":10,"char_end":10}],"removes":[]}'::jsonb
  ),
  'zero-length span char_start = char_end is rejected'
);

select ok(
  not public.sync_v2_payload_is_allowed(
    'coding.patch',
    '{"adds":[{"interview_id":"iv1","segment_id":"seg1","code_id":"c1","char_start":20,"char_end":10}],"removes":[]}'::jsonb
  ),
  'inverted span char_end < char_start is rejected'
);

-- ── Realtime sync_project_heads table privilege checks (t03) ──────────────────
select ok(
  has_table_privilege('authenticated', 'public.sync_project_heads', 'select'),
  'authenticated clients have table-level SELECT on sync_project_heads'
);

select ok(
  not has_table_privilege('authenticated', 'public.sync_project_heads', 'insert'),
  'authenticated clients cannot insert into sync_project_heads'
);

select ok(
  not has_table_privilege('authenticated', 'public.sync_project_heads', 'update'),
  'authenticated clients cannot update sync_project_heads'
);

select ok(
  not has_table_privilege('authenticated', 'public.sync_project_heads', 'delete'),
  'authenticated clients cannot delete from sync_project_heads'
);

select ok(
  not has_table_privilege('anon', 'public.sync_project_heads', 'select'),
  'anonymous clients have no SELECT on sync_project_heads'
);

select ok(
  not has_table_privilege('authenticated', 'public.sync_devices', 'select'),
  'authenticated clients have no table-level SELECT on sync_devices'
);

select ok(
  not has_table_privilege('authenticated', 'public.sync_member_readiness', 'select'),
  'authenticated clients have no table-level SELECT on sync_member_readiness'
);

select ok(
  not has_table_privilege('authenticated', 'public.sync_conflicts', 'select'),
  'authenticated clients have no table-level SELECT on sync_conflicts'
);

select ok(
  not has_table_privilege('authenticated', 'public.sync_changes', 'select'),
  'authenticated clients have no table-level SELECT on sync_changes'
);

-- ── RLS and Full sync_v2_apply Path (t02 & t03) ───────────────────────────────
grant select, insert, update, delete on public.projects,
  public.project_members, public.codebook, public.interviews,
  public.coded_segments, public.project_invites to authenticated;

create temp table if not exists v2_test_capture (
  label text primary key,
  ok boolean,
  value text
) on commit drop;
grant select, insert, update, delete on v2_test_capture to authenticated;

-- Create synthetic users
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values
  ('11111111-1111-4000-8000-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'member_a@fleuron.test', '', now()),
  ('22222222-2222-4000-8000-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nonmember_b@fleuron.test', '', now())
on conflict (id) do nothing;

-- Ensure entitlements exist if table exists
insert into public.entitlements (user_id, status, plan, source)
values
  ('11111111-1111-4000-8000-111111111111', 'active', 'beta', 'beta_auto'),
  ('22222222-2222-4000-8000-222222222222', 'active', 'beta', 'beta_auto')
on conflict (user_id) do nothing;

-- Register claims for member Alice before inserting project so add_creator_as_member trigger gets auth.uid()
set local request.jwt.claims = '{"sub":"11111111-1111-4000-8000-111111111111","role":"authenticated","email":"member_a@fleuron.test"}';
set local request.jwt.claim.sub = '11111111-1111-4000-8000-111111111111';

-- Create project (add_creator_as_member trigger automatically adds member_a)
insert into public.projects (project_id, title, group_key)
values ('v2-rt-proj', 'Realtime Head Test Study', 'RTHEAD01')
on conflict (project_id) do nothing;

insert into public.codebook (id, project_id, name, color, sort_order)
values ('code1', 'v2-rt-proj', 'Alpha', '#111111', 0)
on conflict (id) do nothing;

set role authenticated;

do $$
declare
  r jsonb;
  gen uuid;
  op_null jsonb;
  apply_res jsonb;
  dev_id uuid := 'aaaaaaaa-1111-4000-8000-111111111111'::uuid;
begin
  r := public.sync_v2_register_device('v2-rt-proj', dev_id, '2.5.0-test', 2, 10, 0);
  r := public.sync_v2_activate('v2-rt-proj');
  gen := (r->>'generation')::uuid;
  insert into v2_test_capture (label, ok, value) values ('generation', true, gen::text);

  -- Op with 2.4.1 style explicit null/null char_start and char_end
  op_null := jsonb_build_object(
    'op_id', '99999999-0000-4000-8000-000000000001'::text,
    'client_seq', 1,
    'entity_type', 'coding',
    'entity_id', 'iv1:seg1:whole:code1',
    'op_kind', 'coding.patch',
    'payload', jsonb_build_object(
      'adds', jsonb_build_array(jsonb_build_object(
        'interview_id', 'iv1',
        'segment_id', 'seg1',
        'code_id', 'code1',
        'char_start', null,
        'char_end', null
      )),
      'removes', '[]'::jsonb
    ),
    'base_field_versions', '{}'::jsonb
  );

  apply_res := public.sync_v2_apply(
    'v2-rt-proj',
    gen,
    dev_id,
    jsonb_build_array(op_null)
  );
  insert into v2_test_capture (label, ok, value) values ('apply_null_first', true, apply_res::text);

  -- Retry the identical operation to test idempotency
  apply_res := public.sync_v2_apply(
    'v2-rt-proj',
    gen,
    dev_id,
    jsonb_build_array(op_null)
  );
  insert into v2_test_capture (label, ok, value) values ('apply_null_retry', true, apply_res::text);
end $$;

-- Verify RLS as member Alice
select is(
  (select count(*)::integer from public.sync_project_heads where project_id = 'v2-rt-proj'),
  1,
  'member can read project head row via RLS'
);

-- Verify RLS as non-member Bob
set local request.jwt.claims = '{"sub":"22222222-2222-4000-8000-222222222222","role":"authenticated","email":"nonmember_b@fleuron.test"}';
set local request.jwt.claim.sub = '22222222-2222-4000-8000-222222222222';
set role authenticated;

select is(
  (select count(*)::integer from public.sync_project_heads where project_id = 'v2-rt-proj'),
  0,
  'non-member receives 0 rows on sync_project_heads via RLS'
);

-- Verify apply results
set role postgres;

select ok(
  (select ok from v2_test_capture where label = 'apply_null_first'),
  'sync_v2_apply successfully accepted 2.4.1 whole-turn encoding with explicit null spans'
);

select ok(
  (select ok from v2_test_capture where label = 'apply_null_retry'),
  'sync_v2_apply successfully accepted idempotent retry of null span operation'
);

select is(
  (select count(*)::integer from public.sync_changes where project_id = 'v2-rt-proj' and op_id = '99999999-0000-4000-8000-000000000001'),
  1,
  'null span operation recorded exactly once in sync_changes after retry'
);

select is(
  (select count(*)::integer from public.coding_assignments where interview_id = 'iv1' and segment_id = 'seg1' and code_id = 'code1' and char_start is null and char_end is null),
  1,
  'coding_assignments has whole-turn assignment from null span operation'
);

select * from finish();
rollback;
