begin;

select plan(11);

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

select * from finish();
rollback;
