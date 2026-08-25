begin;

alter table public.projects
  add column if not exists sync_protocol integer not null default 1
    check (sync_protocol in (1, 2)),
  add column if not exists sync_generation uuid,
  add column if not exists sync_head bigint not null default 0,
  add column if not exists sync_activated_at timestamptz;

alter table public.codebook
  add column if not exists field_versions jsonb not null default '{}'::jsonb,
  add column if not exists tombstoned_at timestamptz,
  add column if not exists tombstone_seq bigint,
  add column if not exists inclusion_criteria text check (length(inclusion_criteria) <= 2000),
  add column if not exists exclusion_criteria text check (length(exclusion_criteria) <= 2000),
  add column if not exists example text check (length(example) <= 2000);

alter table public.interviews
  add column if not exists field_versions jsonb not null default '{}'::jsonb,
  add column if not exists tombstoned_at timestamptz,
  add column if not exists tombstone_seq bigint;

create table if not exists public.sync_devices (
  project_id text not null references public.projects(project_id) on delete cascade,
  device_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_version text not null check (length(client_version) <= 64),
  max_protocol integer not null check (max_protocol >= 1 and max_protocol <= 2),
  local_schema_version integer not null check (local_schema_version >= 0),
  legacy_pending_count integer not null default 0 check (legacy_pending_count >= 0),
  last_seen_at timestamptz not null default now(),
  ready_at timestamptz,
  primary key (project_id, device_id)
);

create table if not exists public.sync_member_readiness (
  project_id text not null references public.projects(project_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ready_generation uuid,
  ready_at timestamptz,
  last_device_id uuid,
  primary key (project_id, user_id)
);

create table if not exists public.sync_changes (
  project_id text not null references public.projects(project_id) on delete cascade,
  generation uuid not null,
  seq bigint not null check (seq > 0),
  op_id uuid not null,
  device_id uuid,
  user_id uuid references auth.users(id) on delete set null,
  actor_key text not null check (length(actor_key) <= 180),
  entity_type text not null check (entity_type in ('code', 'coding', 'interview', 'conflict', 'project')),
  entity_id text not null check (length(entity_id) <= 200),
  op_kind text not null check (length(op_kind) <= 80),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (project_id, generation, seq),
  unique (project_id, op_id)
);

create index if not exists sync_changes_project_generation_seq_idx
  on public.sync_changes (project_id, generation, seq);

create table if not exists public.sync_operation_receipts (
  project_id text not null references public.projects(project_id) on delete cascade,
  op_id uuid not null,
  generation uuid not null,
  first_seq bigint,
  last_seq bigint,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (project_id, op_id)
);

create table if not exists public.sync_project_heads (
  project_id text primary key references public.projects(project_id) on delete cascade,
  generation uuid,
  head_seq bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.coding_assignments (
  project_id text not null references public.projects(project_id) on delete cascade,
  interview_id text not null,
  segment_id text not null,
  actor_key text not null check (length(actor_key) <= 180),
  span_key text not null,
  code_id text not null,
  char_start integer,
  char_end integer,
  present boolean not null default true,
  version_seq bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, interview_id, segment_id, actor_key, span_key, code_id),
  check ((char_start is null and char_end is null) or (char_start is not null and char_end is not null and char_start >= 0 and char_end > char_start))
);

create index if not exists coding_assignments_project_interview_idx
  on public.coding_assignments (project_id, interview_id, segment_id)
  where present;

create table if not exists public.sync_conflicts (
  conflict_id uuid primary key default gen_random_uuid(),
  project_id text not null references public.projects(project_id) on delete cascade,
  generation uuid not null,
  entity_type text not null check (entity_type in ('code', 'coding', 'interview')),
  entity_id text not null,
  field_name text not null,
  current_value jsonb not null,
  proposed_value jsonb not null,
  base_value jsonb,
  originating_op_id uuid not null,
  created_by uuid references auth.users(id) on delete set null,
  status text not null default 'unresolved' check (status in ('unresolved', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_seq bigint,
  resolution jsonb
);

create index if not exists sync_conflicts_open_idx
  on public.sync_conflicts (project_id, generation, created_at)
  where status = 'unresolved';

alter table public.sync_devices enable row level security;
alter table public.sync_member_readiness enable row level security;
alter table public.sync_changes enable row level security;
alter table public.sync_operation_receipts enable row level security;
alter table public.sync_project_heads enable row level security;
alter table public.coding_assignments enable row level security;
alter table public.sync_conflicts enable row level security;

revoke all on table public.sync_devices from public, anon, authenticated;
revoke all on table public.sync_member_readiness from public, anon, authenticated;
revoke all on table public.sync_changes from public, anon, authenticated;
revoke all on table public.sync_operation_receipts from public, anon, authenticated;
revoke all on table public.sync_project_heads from public, anon, authenticated;
revoke all on table public.coding_assignments from public, anon, authenticated;
revoke all on table public.sync_conflicts from public, anon, authenticated;

drop policy if exists sync_conflicts_member_read on public.sync_conflicts;
create policy sync_conflicts_member_read on public.sync_conflicts
  for select using (public.is_project_member(project_id));

drop policy if exists sync_devices_member_read on public.sync_devices;
create policy sync_devices_member_read on public.sync_devices
  for select using (public.is_project_member(project_id));

drop policy if exists sync_member_readiness_member_read on public.sync_member_readiness;
create policy sync_member_readiness_member_read on public.sync_member_readiness
  for select using (public.is_project_member(project_id));

drop policy if exists sync_project_heads_member_read on public.sync_project_heads;
create policy sync_project_heads_member_read on public.sync_project_heads
  for select using (public.is_project_member(project_id));

drop policy if exists codebook_rw on public.codebook;
create policy codebook_rw on public.codebook
  for all using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = codebook.project_id and p.sync_protocol = 1)
  ) with check (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = codebook.project_id and p.sync_protocol = 1)
  );

drop policy if exists interviews_rw on public.interviews;
create policy interviews_rw on public.interviews
  for all using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = interviews.project_id and p.sync_protocol = 1)
  ) with check (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = interviews.project_id and p.sync_protocol = 1)
  );

drop policy if exists coded_segments_rw on public.coded_segments;
create policy coded_segments_rw on public.coded_segments
  for all using (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = coded_segments.project_id and p.sync_protocol = 1)
  ) with check (
    public.is_project_member(project_id)
    and exists (select 1 from public.projects p where p.project_id = coded_segments.project_id and p.sync_protocol = 1)
  );

create or replace function public.sync_v2_require_member(p_project_id text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.is_project_member(p_project_id) then
    raise exception 'You do not have permission to access this study.' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.sync_v2_require_admin(p_project_id text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.sync_v2_require_member(p_project_id);
  if not exists (
    select 1 from public.project_members
     where project_id = p_project_id and user_id = auth.uid() and role = 'admin'
  ) then
    raise exception 'Only a study administrator can activate Sync Protocol 2.' using errcode = '42501';
  end if;
end;
$$;

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

create or replace function public.sync_v2_keys_allowed(p_value jsonb, p_allowed text[])
returns boolean
language sql immutable
set search_path = public
as $$
  select jsonb_typeof(p_value) = 'object'
     and not exists (
       select 1 from jsonb_object_keys(p_value) key where not (key = any(p_allowed))
     );
$$;

create or replace function public.sync_v2_payload_is_allowed(p_op_kind text, p_payload jsonb)
returns boolean
language plpgsql immutable
set search_path = public
as $$
declare
  edge jsonb;
  field text;
  patch jsonb;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    return false;
  end if;

  if p_payload ?| array[
    'memo', 'transcript', 'segment_text', 'text', 'quote_text', 'diagnosis',
    'audio_path', 'raw_vtt_path', 'path', 'filename', 'email', 'token', 'url'
  ] then
    return false;
  end if;

  if p_op_kind = 'code.create' then
    if not public.sync_v2_keys_allowed(
      p_payload,
      array['name', 'definition', 'inclusion_criteria', 'exclusion_criteria', 'example', 'parent_id', 'color', 'sort_order']
    ) or jsonb_typeof(p_payload->'name') <> 'string' or length(p_payload->>'name') > 200 then
      return false;
    end if;
    return coalesce(length(p_payload->>'definition') <= 2000, true)
      and coalesce(length(p_payload->>'inclusion_criteria') <= 2000, true)
      and coalesce(length(p_payload->>'exclusion_criteria') <= 2000, true)
      and coalesce(length(p_payload->>'example') <= 2000, true)
      and coalesce(length(p_payload->>'parent_id') <= 200, true)
      and coalesce(length(p_payload->>'color') <= 32, true);
  end if;

  if p_op_kind = 'code.patch' then
    if not public.sync_v2_keys_allowed(p_payload, array['patch']) then
      return false;
    end if;
    patch := p_payload->'patch';
    if jsonb_typeof(patch) <> 'object' or not public.sync_v2_keys_allowed(
      patch,
      array['name', 'definition', 'inclusion_criteria', 'exclusion_criteria', 'example', 'parent_id', 'color', 'sort_order', 'is_retired', 'deleted']
    ) then
      return false;
    end if;
    foreach field in array array['name', 'definition', 'inclusion_criteria', 'exclusion_criteria', 'example', 'parent_id', 'color'] loop
      if patch ? field and jsonb_typeof(patch->field) not in ('string', 'null') then
        return false;
      end if;
    end loop;
    if patch ? 'deleted' and jsonb_typeof(patch->'deleted') <> 'boolean' then
      return false;
    end if;
    return coalesce(length(patch->>'name') <= 200, true)
      and coalesce(length(patch->>'definition') <= 2000, true)
      and coalesce(length(patch->>'inclusion_criteria') <= 2000, true)
      and coalesce(length(patch->>'exclusion_criteria') <= 2000, true)
      and coalesce(length(patch->>'example') <= 2000, true)
      and coalesce(length(patch->>'parent_id') <= 200, true)
      and coalesce(length(patch->>'color') <= 32, true);
  end if;

  if p_op_kind in ('code.retire', 'code.purge') then
    return public.sync_v2_keys_allowed(p_payload, array[]::text[]);
  end if;

  if p_op_kind = 'coding.patch' then
    if not public.sync_v2_keys_allowed(p_payload, array['adds', 'removes']) then
      return false;
    end if;
    if jsonb_typeof(coalesce(p_payload->'adds', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(p_payload->'removes', '[]'::jsonb)) <> 'array' then
      return false;
    end if;
    for edge in select value from jsonb_array_elements(coalesce(p_payload->'adds', '[]'::jsonb))
                union all
                select value from jsonb_array_elements(coalesce(p_payload->'removes', '[]'::jsonb)) loop
      if not public.sync_v2_keys_allowed(edge, array['interview_id', 'segment_id', 'code_id', 'char_start', 'char_end'])
         or jsonb_typeof(edge->'interview_id') <> 'string'
         or jsonb_typeof(edge->'segment_id') <> 'string'
         or jsonb_typeof(edge->'code_id') <> 'string'
         or length(edge->>'interview_id') > 200
         or length(edge->>'segment_id') > 200
         or length(edge->>'code_id') > 200 then
        return false;
      end if;
      if (edge ? 'char_start') <> (edge ? 'char_end') then
        return false;
      end if;
      if edge ? 'char_start' and (
        jsonb_typeof(edge->'char_start') <> 'number'
        or jsonb_typeof(edge->'char_end') <> 'number'
        or (edge->>'char_start')::integer < 0
        or (edge->>'char_end')::integer <= (edge->>'char_start')::integer
      ) then
        return false;
      end if;
    end loop;
    return true;
  end if;

  if p_op_kind = 'interview.patch' then
    if not public.sync_v2_keys_allowed(p_payload, array['patch']) then
      return false;
    end if;
    patch := p_payload->'patch';
    if jsonb_typeof(patch) <> 'object' or not public.sync_v2_keys_allowed(patch, array['study_label', 'segment_count', 'content_hash', 'deleted']) then
      return false;
    end if;
    return coalesce(length(patch->>'study_label') <= 60, true)
      and coalesce(length(patch->>'content_hash') <= 200, true)
      and (not (patch ? 'segment_count') or jsonb_typeof(patch->'segment_count') = 'number')
      and (not (patch ? 'deleted') or jsonb_typeof(patch->'deleted') = 'boolean');
  end if;

  return false;
end;
$$;

create or replace function public.sync_v2_register_device(
  project_id text,
  device_id uuid,
  client_version text,
  max_protocol integer,
  local_schema_version integer,
  legacy_pending_count integer
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  p public.projects%rowtype;
  ready boolean;
begin
  perform public.sync_v2_require_member(sync_v2_register_device.project_id);
  select * into p from public.projects where projects.project_id = sync_v2_register_device.project_id for update;
  if not found then
    raise exception 'Study does not exist.';
  end if;
  if max_protocol not in (1, 2) or local_schema_version < 0 or legacy_pending_count < 0 then
    raise exception 'Invalid device capability report.';
  end if;
  ready := p.sync_protocol = 1 and max_protocol >= 2 and local_schema_version >= 6 and legacy_pending_count = 0;
  insert into public.sync_devices (
    project_id, device_id, user_id, client_version, max_protocol,
    local_schema_version, legacy_pending_count, last_seen_at, ready_at
  ) values (
    sync_v2_register_device.project_id, sync_v2_register_device.device_id, auth.uid(), sync_v2_register_device.client_version, sync_v2_register_device.max_protocol,
    sync_v2_register_device.local_schema_version, sync_v2_register_device.legacy_pending_count, now(), case when ready then now() else null end
  ) on conflict (project_id, device_id) do update
    set user_id = excluded.user_id,
        client_version = excluded.client_version,
        max_protocol = excluded.max_protocol,
        local_schema_version = excluded.local_schema_version,
        legacy_pending_count = excluded.legacy_pending_count,
        last_seen_at = excluded.last_seen_at,
        ready_at = excluded.ready_at;
  insert into public.sync_member_readiness (
    project_id, user_id, ready_generation, ready_at, last_device_id
  ) values (
    sync_v2_register_device.project_id, auth.uid(), null, case when ready then now() else null end, sync_v2_register_device.device_id
  ) on conflict (project_id, user_id) do update
    set ready_generation = null,
        ready_at = excluded.ready_at,
        last_device_id = excluded.last_device_id;
  return jsonb_build_object(
    'protocol', p.sync_protocol,
    'generation', p.sync_generation,
    'head', p.sync_head,
    'ready', ready
  );
end;
$$;

create or replace function public.sync_v2_open_conflict(
  p_project_id text,
  p_generation uuid,
  p_entity_type text,
  p_entity_id text,
  p_field_name text,
  p_current_value jsonb,
  p_proposed_value jsonb,
  p_base_value jsonb,
  p_originating_op_id uuid,
  p_created_by uuid
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  created_id uuid;
begin
  insert into public.sync_conflicts (
    project_id, generation, entity_type, entity_id, field_name,
    current_value, proposed_value, base_value, originating_op_id, created_by
  ) values (
    p_project_id, p_generation, p_entity_type, p_entity_id, p_field_name,
    p_current_value, p_proposed_value, p_base_value, p_originating_op_id, p_created_by
  ) returning conflict_id into created_id;
  return created_id;
end;
$$;

create or replace function public.sync_v2_apply(
  project_id text,
  generation uuid,
  device_id uuid,
  operations jsonb
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  p public.projects%rowtype;
  op jsonb;
  patch jsonb;
  safe_patch jsonb;
  result jsonb;
  prior_result jsonb;
  receipts jsonb := '[]'::jsonb;
  conflict_ids jsonb;
  field_name text;
  field_value jsonb;
  version_values jsonb;
  actor_key text := 'user:' || auth.uid()::text;
  op_uuid uuid;
  client_seq bigint;
  prior_client_seq bigint := -1;
  op_kind text;
  entity_type text;
  entity_id text;
  sequence bigint;
  conflict_id uuid;
  edge jsonb;
  edge_present boolean;
  edge_start integer;
  edge_end integer;
  edge_span_key text;
  code_deleted boolean;
  code_row public.codebook%rowtype;
  interview_row public.interviews%rowtype;
begin
  perform public.sync_v2_require_member(sync_v2_apply.project_id);
  if jsonb_typeof(operations) <> 'array' or jsonb_array_length(operations) > 200 then
    raise exception 'Sync operation batches must contain at most 200 operations.';
  end if;

  select * into p
    from public.projects
   where projects.project_id = sync_v2_apply.project_id
   for update;
  if not found then
    raise exception 'Study does not exist.';
  end if;
  if p.sync_protocol <> 2 then
    raise exception 'This study has not activated Sync Protocol 2.' using errcode = '42501';
  end if;
  if p.sync_generation is distinct from generation then
    raise exception 'Sync generation does not match this study.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.sync_devices d
     where d.project_id = sync_v2_apply.project_id
       and d.device_id = sync_v2_apply.device_id
       and d.user_id = auth.uid()
  ) then
    raise exception 'Register this device before applying Sync Protocol 2 operations.' using errcode = '42501';
  end if;

  for op in select value from jsonb_array_elements(operations) loop
    if not public.sync_v2_keys_allowed(op, array['op_id', 'client_seq', 'entity_type', 'entity_id', 'op_kind', 'payload', 'base_field_versions'])
       or jsonb_typeof(op->'op_id') <> 'string'
       or jsonb_typeof(op->'client_seq') <> 'number'
       or jsonb_typeof(op->'entity_type') <> 'string'
       or jsonb_typeof(op->'entity_id') <> 'string'
       or jsonb_typeof(op->'op_kind') <> 'string'
       or jsonb_typeof(op->'payload') <> 'object'
       or jsonb_typeof(coalesce(op->'base_field_versions', '{}'::jsonb)) <> 'object' then
      raise exception 'Malformed Sync Protocol 2 operation.' using errcode = '22023';
    end if;
    op_uuid := (op->>'op_id')::uuid;
    client_seq := (op->>'client_seq')::bigint;
    if client_seq <= prior_client_seq then
      raise exception 'Operations must be ordered by strictly increasing client_seq.' using errcode = '22023';
    end if;
    prior_client_seq := client_seq;
    entity_type := op->>'entity_type';
    entity_id := op->>'entity_id';
    op_kind := op->>'op_kind';
    if length(entity_id) > 200 or not public.sync_v2_payload_is_allowed(op_kind, op->'payload') then
      raise exception 'Operation payload contains a field or value that is not permitted for sync.' using errcode = '22023';
    end if;

    select r.result into prior_result
      from public.sync_operation_receipts r
     where r.project_id = sync_v2_apply.project_id and r.op_id = op_uuid;
    if found then
      receipts := receipts || jsonb_build_array(prior_result);
      continue;
    end if;

    sequence := public.sync_v2_record_change(
      sync_v2_apply.project_id, generation, op_uuid, device_id, auth.uid(), actor_key,
      entity_type, entity_id, op_kind, op->'payload'
    );
    conflict_ids := '[]'::jsonb;
    safe_patch := '{}'::jsonb;

    if op_kind = 'code.create' and entity_type = 'code' then
      select * into code_row from public.codebook c where c.id = entity_id;
      if found then
        conflict_id := public.sync_v2_open_conflict(
          sync_v2_apply.project_id, generation, 'code', entity_id, '__entity__',
          to_jsonb(code_row), op->'payload', null, op_uuid, auth.uid()
        );
        conflict_ids := jsonb_build_array(conflict_id);
      elsif exists (
        select 1 from public.codebook c
         where c.project_id = sync_v2_apply.project_id
           and not c.deleted
           and lower(c.name) = lower(op->'payload'->>'name')
      ) then
        select * into code_row from public.codebook c
         where c.project_id = sync_v2_apply.project_id
           and not c.deleted
           and lower(c.name) = lower(op->'payload'->>'name')
         limit 1;
        conflict_id := public.sync_v2_open_conflict(
          sync_v2_apply.project_id, generation, 'code', entity_id, 'name',
          jsonb_build_object('name', code_row.name),
          op->'payload', null, op_uuid, auth.uid()
        );
        conflict_ids := jsonb_build_array(conflict_id);
      else
        insert into public.codebook (
          id, project_id, name, definition, inclusion_criteria, exclusion_criteria,
          example, parent_id, color, sort_order, field_versions, revision, updated_at
        ) values (
          entity_id, sync_v2_apply.project_id, op->'payload'->>'name',
          op->'payload'->>'definition', op->'payload'->>'inclusion_criteria',
          op->'payload'->>'exclusion_criteria', op->'payload'->>'example',
          op->'payload'->>'parent_id', op->'payload'->>'color',
          coalesce((op->'payload'->>'sort_order')::integer, 0),
          jsonb_build_object(
            'name', sequence, 'definition', sequence, 'inclusion_criteria', sequence,
            'exclusion_criteria', sequence, 'example', sequence, 'parent_id', sequence,
            'color', sequence, 'sort_order', sequence
          ), 0, now()
        );
      end if;

    elsif op_kind = 'code.patch' and entity_type = 'code' then
      select * into code_row from public.codebook c
       where c.id = entity_id and c.project_id = sync_v2_apply.project_id;
      if not found then
        conflict_id := public.sync_v2_open_conflict(
          sync_v2_apply.project_id, generation, 'code', entity_id, '__entity__',
          '{}'::jsonb, op->'payload', null, op_uuid, auth.uid()
        );
        conflict_ids := jsonb_build_array(conflict_id);
      else
        patch := op->'payload'->'patch';
        for field_name, field_value in select key, value from jsonb_each(patch) loop
          if coalesce((code_row.field_versions->>field_name)::bigint, 0)
             = coalesce((op->'base_field_versions'->>field_name)::bigint, 0) then
            safe_patch := safe_patch || jsonb_build_object(field_name, field_value);
          else
            conflict_id := public.sync_v2_open_conflict(
              sync_v2_apply.project_id, generation, 'code', entity_id, field_name,
              jsonb_build_object(field_name, to_jsonb(code_row)->field_name),
              jsonb_build_object(field_name, field_value),
              jsonb_build_object(field_name, op->'base_field_versions'->field_name),
              op_uuid, auth.uid()
            );
            conflict_ids := conflict_ids || jsonb_build_array(conflict_id);
          end if;
        end loop;
        select coalesce(jsonb_object_agg(keys.key, to_jsonb(sequence)), '{}'::jsonb)
          into version_values from jsonb_object_keys(safe_patch) as keys(key);
        update public.codebook c
           set name = case when safe_patch ? 'name' then safe_patch->>'name' else c.name end,
               definition = case when safe_patch ? 'definition' then safe_patch->>'definition' else c.definition end,
               inclusion_criteria = case when safe_patch ? 'inclusion_criteria' then safe_patch->>'inclusion_criteria' else c.inclusion_criteria end,
               exclusion_criteria = case when safe_patch ? 'exclusion_criteria' then safe_patch->>'exclusion_criteria' else c.exclusion_criteria end,
               example = case when safe_patch ? 'example' then safe_patch->>'example' else c.example end,
               parent_id = case when safe_patch ? 'parent_id' then safe_patch->>'parent_id' else c.parent_id end,
               color = case when safe_patch ? 'color' then safe_patch->>'color' else c.color end,
               sort_order = case when safe_patch ? 'sort_order' then (safe_patch->>'sort_order')::integer else c.sort_order end,
               is_retired = case when safe_patch ? 'is_retired' then (safe_patch->>'is_retired')::boolean else c.is_retired end,
               deleted = case when safe_patch ? 'deleted' then (safe_patch->>'deleted')::boolean else c.deleted end,
               tombstoned_at = case when safe_patch ? 'deleted' and (safe_patch->>'deleted')::boolean then now() else c.tombstoned_at end,
               tombstone_seq = case when safe_patch ? 'deleted' and (safe_patch->>'deleted')::boolean then sequence else c.tombstone_seq end,
               field_versions = c.field_versions || version_values,
               revision = c.revision + case when safe_patch = '{}'::jsonb then 0 else 1 end,
               updated_at = now()
         where c.id = entity_id and c.project_id = sync_v2_apply.project_id;
      end if;

    elsif op_kind in ('code.retire', 'code.purge') and entity_type = 'code' then
      select * into code_row from public.codebook c
       where c.id = entity_id and c.project_id = sync_v2_apply.project_id;
      if not found then
        conflict_id := public.sync_v2_open_conflict(
          sync_v2_apply.project_id, generation, 'code', entity_id, '__entity__',
          '{}'::jsonb, op->'payload', null, op_uuid, auth.uid()
        );
        conflict_ids := jsonb_build_array(conflict_id);
      elsif op_kind = 'code.retire' then
        update public.codebook c
           set is_retired = true,
               field_versions = c.field_versions || jsonb_build_object('is_retired', sequence),
               revision = c.revision + 1,
               updated_at = now()
         where c.id = entity_id and c.project_id = sync_v2_apply.project_id;
      else
        update public.codebook c
           set deleted = true,
               tombstoned_at = now(),
               tombstone_seq = sequence,
               field_versions = c.field_versions || jsonb_build_object('deleted', sequence),
               revision = c.revision + 1,
               updated_at = now()
         where c.id = entity_id and c.project_id = sync_v2_apply.project_id;
        update public.coding_assignments a
           set present = false, version_seq = sequence, updated_at = now()
         where a.project_id = sync_v2_apply.project_id and a.code_id = entity_id and a.present;
      end if;

    elsif op_kind = 'coding.patch' and entity_type = 'coding' then
      for edge, edge_present in
        select value, true from jsonb_array_elements(coalesce(op->'payload'->'adds', '[]'::jsonb))
        union all
        select value, false from jsonb_array_elements(coalesce(op->'payload'->'removes', '[]'::jsonb))
      loop
        edge_start := case when edge ? 'char_start' then (edge->>'char_start')::integer else null end;
        edge_end := case when edge ? 'char_end' then (edge->>'char_end')::integer else null end;
        edge_span_key := coalesce(edge_start::text, '*') || ':' || coalesce(edge_end::text, '*');
        select c.deleted into code_deleted from public.codebook c
         where c.id = edge->>'code_id' and c.project_id = sync_v2_apply.project_id;
        if not found or code_deleted then
          conflict_id := public.sync_v2_open_conflict(
            sync_v2_apply.project_id, generation, 'coding', entity_id, 'code_id',
            jsonb_build_object('code_id', edge->>'code_id'), edge, null, op_uuid, auth.uid()
          );
          conflict_ids := conflict_ids || jsonb_build_array(conflict_id);
        else
          insert into public.coding_assignments (
            project_id, interview_id, segment_id, actor_key, span_key, code_id,
            char_start, char_end, present, version_seq, updated_at
          ) values (
            sync_v2_apply.project_id, edge->>'interview_id', edge->>'segment_id', actor_key,
            edge_span_key, edge->>'code_id', edge_start, edge_end, edge_present, sequence, now()
          ) on conflict (project_id, interview_id, segment_id, actor_key, span_key, code_id) do update
            set present = excluded.present,
                version_seq = excluded.version_seq,
                updated_at = excluded.updated_at;
        end if;
      end loop;

    elsif op_kind = 'interview.patch' and entity_type = 'interview' then
      select * into interview_row from public.interviews i
       where i.id = entity_id and i.project_id = sync_v2_apply.project_id;
      patch := op->'payload'->'patch';
      if not found then
        insert into public.interviews (
          id, project_id, study_label, segment_count, content_hash, deleted,
          field_versions, revision, updated_at
        ) values (
          entity_id, sync_v2_apply.project_id,
          coalesce(patch->>'study_label', entity_id),
          coalesce((patch->>'segment_count')::integer, 0), patch->>'content_hash',
          coalesce((patch->>'deleted')::boolean, false),
          jsonb_build_object('study_label', sequence, 'segment_count', sequence, 'content_hash', sequence, 'deleted', sequence),
          0, now()
        );
      else
        for field_name, field_value in select key, value from jsonb_each(patch) loop
          if coalesce((interview_row.field_versions->>field_name)::bigint, 0)
             = coalesce((op->'base_field_versions'->>field_name)::bigint, 0) then
            safe_patch := safe_patch || jsonb_build_object(field_name, field_value);
          else
            conflict_id := public.sync_v2_open_conflict(
              sync_v2_apply.project_id, generation, 'interview', entity_id, field_name,
              jsonb_build_object(field_name, to_jsonb(interview_row)->field_name),
              jsonb_build_object(field_name, field_value),
              jsonb_build_object(field_name, op->'base_field_versions'->field_name),
              op_uuid, auth.uid()
            );
            conflict_ids := conflict_ids || jsonb_build_array(conflict_id);
          end if;
        end loop;
        select coalesce(jsonb_object_agg(keys.key, to_jsonb(sequence)), '{}'::jsonb)
          into version_values from jsonb_object_keys(safe_patch) as keys(key);
        update public.interviews i
           set study_label = case when safe_patch ? 'study_label' then safe_patch->>'study_label' else i.study_label end,
               segment_count = case when safe_patch ? 'segment_count' then (safe_patch->>'segment_count')::integer else i.segment_count end,
               content_hash = case when safe_patch ? 'content_hash' then safe_patch->>'content_hash' else i.content_hash end,
               deleted = case when safe_patch ? 'deleted' then (safe_patch->>'deleted')::boolean else i.deleted end,
               tombstoned_at = case when safe_patch ? 'deleted' and (safe_patch->>'deleted')::boolean then now() else i.tombstoned_at end,
               tombstone_seq = case when safe_patch ? 'deleted' and (safe_patch->>'deleted')::boolean then sequence else i.tombstone_seq end,
               field_versions = i.field_versions || version_values,
               revision = i.revision + case when safe_patch = '{}'::jsonb then 0 else 1 end,
               updated_at = now()
         where i.id = entity_id and i.project_id = sync_v2_apply.project_id;
      end if;

    else
      raise exception 'Unsupported Sync Protocol 2 operation kind % for entity type %.', op_kind, entity_type using errcode = '22023';
    end if;

    result := jsonb_build_object(
      'op_id', op_uuid,
      'status', case when jsonb_array_length(conflict_ids) > 0 then 'conflicted' else 'applied' end,
      'first_seq', sequence,
      'last_seq', sequence,
      'conflict_ids', conflict_ids
    );
    insert into public.sync_operation_receipts (
      project_id, op_id, generation, first_seq, last_seq, result
    ) values (
      sync_v2_apply.project_id, op_uuid, generation, sequence, sequence, result
    );
    receipts := receipts || jsonb_build_array(result);
  end loop;

  select sync_head into p.sync_head from public.projects where projects.project_id = sync_v2_apply.project_id;
  return jsonb_build_object('generation', generation, 'head', p.sync_head, 'receipts', receipts);
end;
$$;

create or replace function public.sync_v2_pull(
  project_id text,
  generation uuid,
  after_seq bigint,
  limit_count integer
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  p public.projects%rowtype;
  changes jsonb;
  conflicts jsonb;
begin
  perform public.sync_v2_require_member(sync_v2_pull.project_id);
  if after_seq < 0 or limit_count < 1 or limit_count > 500 then
    raise exception 'Invalid Sync Protocol 2 pull range.' using errcode = '22023';
  end if;
  select * into p from public.projects
   where projects.project_id = sync_v2_pull.project_id;
  if not found or p.sync_protocol <> 2 or p.sync_generation is distinct from generation then
    raise exception 'Sync generation does not match this study.' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'seq', c.seq,
    'op_id', c.op_id,
    'device_id', c.device_id,
    'user_id', c.user_id,
    'actor_key', c.actor_key,
    'entity_type', c.entity_type,
    'entity_id', c.entity_id,
    'op_kind', c.op_kind,
    'payload', c.payload,
    'created_at', c.created_at
  ) order by c.seq), '[]'::jsonb) into changes
    from (
      select * from public.sync_changes
       where sync_changes.project_id = sync_v2_pull.project_id
         and sync_changes.generation = sync_v2_pull.generation
         and sync_changes.seq > after_seq
       order by sync_changes.seq
       limit limit_count
    ) c;
  select coalesce(jsonb_agg(jsonb_build_object(
    'conflict_id', c.conflict_id,
    'entity_type', c.entity_type,
    'entity_id', c.entity_id,
    'field_name', c.field_name,
    'current_value', c.current_value,
    'proposed_value', c.proposed_value,
    'base_value', c.base_value,
    'originating_op_id', c.originating_op_id,
    'proposer_label', (
      select m.coder_name from public.project_members m
       where m.project_id = c.project_id and m.user_id = c.created_by
    ),
    'status', c.status,
    'created_at', c.created_at,
    'resolved_seq', c.resolved_seq
  ) order by c.created_at, c.conflict_id), '[]'::jsonb)
    into conflicts
    from public.sync_conflicts c
   where c.project_id = sync_v2_pull.project_id
     and c.generation = sync_v2_pull.generation;
  return jsonb_build_object(
    'generation', generation,
    'head', p.sync_head,
    'changes', changes,
    'conflicts', conflicts
  );
end;
$$;

create or replace function public.sync_v2_snapshot(
  project_id text,
  generation uuid
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  p public.projects%rowtype;
  snapshot jsonb;
begin
  perform public.sync_v2_require_member(sync_v2_snapshot.project_id);
  select * into p from public.projects
   where projects.project_id = sync_v2_snapshot.project_id;
  if not found or p.sync_protocol <> 2 or p.sync_generation is distinct from generation then
    raise exception 'Sync generation does not match this study.' using errcode = '22023';
  end if;
  snapshot := jsonb_build_object(
    'replay_required', false,
    'generation', generation,
    'snapshot_seq', p.sync_head,
    'codes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'definition', c.definition,
        'inclusion_criteria', c.inclusion_criteria, 'exclusion_criteria', c.exclusion_criteria,
        'example', c.example, 'parent_id', c.parent_id, 'color', c.color,
        'sort_order', c.sort_order, 'is_retired', c.is_retired, 'deleted', c.deleted,
        'field_versions', c.field_versions, 'tombstone_seq', c.tombstone_seq
      ) order by c.id)
      from public.codebook c where c.project_id = sync_v2_snapshot.project_id
    ), '[]'::jsonb),
    'interviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'study_label', i.study_label, 'segment_count', i.segment_count,
        'content_hash', i.content_hash, 'deleted', i.deleted,
        'field_versions', i.field_versions, 'tombstone_seq', i.tombstone_seq
      ) order by i.id)
      from public.interviews i where i.project_id = sync_v2_snapshot.project_id
    ), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'interview_id', a.interview_id, 'segment_id', a.segment_id,
        'actor_key', a.actor_key, 'span_key', a.span_key, 'code_id', a.code_id,
        'char_start', a.char_start, 'char_end', a.char_end, 'present', a.present,
        'version_seq', a.version_seq
      ) order by a.interview_id, a.segment_id, a.actor_key, a.span_key, a.code_id)
      from public.coding_assignments a where a.project_id = sync_v2_snapshot.project_id
    ), '[]'::jsonb),
    'conflicts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'conflict_id', c.conflict_id, 'entity_type', c.entity_type,
        'entity_id', c.entity_id, 'field_name', c.field_name,
        'current_value', c.current_value, 'proposed_value', c.proposed_value,
        'base_value', c.base_value, 'originating_op_id', c.originating_op_id,
        'proposer_label', (
          select m.coder_name from public.project_members m
           where m.project_id = c.project_id and m.user_id = c.created_by
        ),
        'status', c.status, 'created_at', c.created_at,
        'resolved_seq', c.resolved_seq
      ) order by c.created_at, c.conflict_id)
      from public.sync_conflicts c
       where c.project_id = sync_v2_snapshot.project_id and c.generation = sync_v2_snapshot.generation
    ), '[]'::jsonb)
  );
  if octet_length(snapshot::text) > 5 * 1024 * 1024 then
    return jsonb_build_object('replay_required', true, 'generation', generation, 'snapshot_seq', p.sync_head);
  end if;
  return snapshot;
end;
$$;

create or replace function public.sync_v2_resolve_conflict(
  conflict_id uuid,
  resolution text,
  custom_value jsonb default null
)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  c public.sync_conflicts%rowtype;
  p public.projects%rowtype;
  chosen jsonb;
  sequence bigint;
  op_uuid uuid := gen_random_uuid();
  actor_key text := 'user:' || auth.uid()::text;
  original_payload jsonb;
  dependent public.sync_conflicts%rowtype;
  dep_entity_id text;
  dep_payload jsonb;
begin
  select * into c from public.sync_conflicts where sync_conflicts.conflict_id = sync_v2_resolve_conflict.conflict_id for update;
  if not found then
    raise exception 'Conflict does not exist.';
  end if;
  perform public.sync_v2_require_member(c.project_id);
  if c.status <> 'unresolved' then
    return jsonb_build_object('conflict_id', c.conflict_id, 'status', 'resolved', 'seq', c.resolved_seq);
  end if;
  if resolution not in ('keep_current', 'accept_proposal', 'custom') then
    raise exception 'Invalid conflict resolution.' using errcode = '22023';
  end if;
  if resolution = 'keep_current' then
    chosen := c.current_value;
  elsif resolution = 'accept_proposal' then
    chosen := c.proposed_value;
  elsif c.entity_type = 'code' and c.field_name = 'name'
        and not exists (select 1 from public.codebook b where b.id = c.entity_id)
  then
    if custom_value is null or jsonb_typeof(custom_value) <> 'string'
       or length(trim(custom_value #>> '{}')) = 0 or length(custom_value #>> '{}') > 200 then
      raise exception 'A distinct code name is required.' using errcode = '22023';
    end if;
    select payload into original_payload
      from public.sync_changes
     where project_id = c.project_id and generation = c.generation and op_id = c.originating_op_id;
    chosen := coalesce(original_payload, '{}'::jsonb) || jsonb_build_object('name', custom_value #>> '{}');
    if not public.sync_v2_payload_is_allowed('code.create', chosen)
       or exists (
         select 1 from public.codebook b
          where b.project_id = c.project_id and not b.deleted
            and lower(b.name) = lower(chosen->>'name')
       ) then
      raise exception 'That code name is already in use or invalid.' using errcode = '22023';
    end if;
  else
    if custom_value is null or jsonb_typeof(custom_value) not in ('string', 'number', 'boolean', 'null') then
      raise exception 'Custom conflict values must be scalar.' using errcode = '22023';
    end if;
    chosen := jsonb_build_object(c.field_name, custom_value);
  end if;
  select * into p from public.projects where projects.project_id = c.project_id for update;
  if p.sync_protocol <> 2 or p.sync_generation is distinct from c.generation then
    raise exception 'Conflict belongs to an inactive sync generation.' using errcode = '22023';
  end if;
  sequence := public.sync_v2_record_change(
    c.project_id, c.generation, op_uuid, null, auth.uid(), actor_key,
    'conflict', c.conflict_id::text, 'conflict.resolve',
    jsonb_build_object('conflict_id', c.conflict_id, 'resolution', resolution, 'value', chosen)
  );
  if resolution = 'custom' and c.entity_type = 'code' and c.field_name = 'name'
     and not exists (select 1 from public.codebook b where b.id = c.entity_id) then
    insert into public.codebook (
      id, project_id, name, definition, inclusion_criteria, exclusion_criteria,
      example, parent_id, color, sort_order, field_versions, revision, updated_at
    ) values (
      c.entity_id, c.project_id, chosen->>'name', chosen->>'definition',
      chosen->>'inclusion_criteria', chosen->>'exclusion_criteria', chosen->>'example',
      chosen->>'parent_id', chosen->>'color', coalesce((chosen->>'sort_order')::integer, 0),
      jsonb_build_object(
        'name', sequence, 'definition', sequence, 'inclusion_criteria', sequence,
        'exclusion_criteria', sequence, 'example', sequence, 'parent_id', sequence,
        'color', sequence, 'sort_order', sequence
      ), 0, now()
    );
  elsif resolution <> 'keep_current' and c.entity_type = 'code' then
    update public.codebook b
       set name = case when c.field_name = 'name' then chosen->>c.field_name else b.name end,
           definition = case when c.field_name = 'definition' then chosen->>c.field_name else b.definition end,
           inclusion_criteria = case when c.field_name = 'inclusion_criteria' then chosen->>c.field_name else b.inclusion_criteria end,
           exclusion_criteria = case when c.field_name = 'exclusion_criteria' then chosen->>c.field_name else b.exclusion_criteria end,
           example = case when c.field_name = 'example' then chosen->>c.field_name else b.example end,
           parent_id = case when c.field_name = 'parent_id' then chosen->>c.field_name else b.parent_id end,
           color = case when c.field_name = 'color' then chosen->>c.field_name else b.color end,
           sort_order = case when c.field_name = 'sort_order' then (chosen->>c.field_name)::integer else b.sort_order end,
           is_retired = case when c.field_name = 'is_retired' then (chosen->>c.field_name)::boolean else b.is_retired end,
           deleted = case when c.field_name = 'deleted' then (chosen->>c.field_name)::boolean else b.deleted end,
           field_versions = b.field_versions || jsonb_build_object(c.field_name, sequence),
           updated_at = now()
     where b.project_id = c.project_id and b.id = c.entity_id;
  elsif resolution <> 'keep_current' and c.entity_type = 'interview' then
    update public.interviews i
       set study_label = case when c.field_name = 'study_label' then chosen->>c.field_name else i.study_label end,
           segment_count = case when c.field_name = 'segment_count' then (chosen->>c.field_name)::integer else i.segment_count end,
           content_hash = case when c.field_name = 'content_hash' then chosen->>c.field_name else i.content_hash end,
           deleted = case when c.field_name = 'deleted' then (chosen->>c.field_name)::boolean else i.deleted end,
           field_versions = i.field_versions || jsonb_build_object(c.field_name, sequence),
           updated_at = now()
     where i.project_id = c.project_id and i.id = c.entity_id;
  end if;
  update public.sync_conflicts
     set status = 'resolved', resolved_at = now(), resolved_seq = sequence,
         resolution = jsonb_build_object('resolution', resolution, 'value', chosen)
   where sync_conflicts.conflict_id = c.conflict_id;
  if resolution = 'custom' and c.entity_type = 'code' and c.field_name = 'name' then
    for dependent in
      select *
        from public.sync_conflicts
       where project_id = c.project_id and generation = c.generation
         and status = 'unresolved' and entity_type = 'coding' and field_name = 'code_id'
         and proposed_value->>'code_id' = c.entity_id
    loop
      update public.sync_conflicts
         set status = 'resolved', resolved_at = now(),
             resolution = jsonb_build_object('resolution', 'mapped_to_resolved_code')
       where sync_conflicts.conflict_id = dependent.conflict_id;
      select sc.actor_key into actor_key
        from public.sync_changes sc
       where sc.project_id = c.project_id and sc.generation = c.generation
         and sc.op_id = dependent.originating_op_id;
      dep_entity_id := (dependent.proposed_value->>'interview_id') || ':' || (dependent.proposed_value->>'segment_id');
      dep_payload := jsonb_build_object('adds', jsonb_build_array(dependent.proposed_value), 'removes', '[]'::jsonb);
      perform public.sync_v2_record_change(
        c.project_id, c.generation, gen_random_uuid(), null, auth.uid(),
        coalesce(actor_key, 'user:' || auth.uid()::text), 'coding',
        dep_entity_id,
        'coding.patch',
        dep_payload
      );
    end loop;
  end if;
  return jsonb_build_object('conflict_id', c.conflict_id, 'status', 'resolved', 'seq', sequence);
end;
$$;

create or replace function public.sync_v2_baseline_op_id(p_value text)
returns uuid
language sql immutable
set search_path = public
as $$
  select (
    substr(md5(p_value), 1, 8) || '-' || substr(md5(p_value), 9, 4) || '-' ||
    substr(md5(p_value), 13, 4) || '-' || substr(md5(p_value), 17, 4) || '-' ||
    substr(md5(p_value), 21, 12)
  )::uuid;
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

create or replace function public.sync_v2_readiness(project_id text)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  p public.projects%rowtype;
  members jsonb;
begin
  perform public.sync_v2_require_member(sync_v2_readiness.project_id);
  select * into p from public.projects where projects.project_id = sync_v2_readiness.project_id;
  if not found then
    raise exception 'Study does not exist.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', m.user_id,
    'coder_name', m.coder_name,
    'role', m.role,
    'ready', r.ready_at is not null,
    'ready_at', r.ready_at,
    'last_device_id', r.last_device_id
  ) order by m.coder_name, m.user_id), '[]'::jsonb)
    into members
    from public.project_members m
    left join public.sync_member_readiness r
      on r.project_id = m.project_id and r.user_id = m.user_id
   where m.project_id = sync_v2_readiness.project_id;
  return jsonb_build_object(
    'protocol', p.sync_protocol,
    'generation', p.sync_generation,
    'head', p.sync_head,
    'members', members
  );
end;
$$;

alter table public.sync_project_heads replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'sync_project_heads'
  ) then
    alter publication supabase_realtime add table public.sync_project_heads;
  end if;
end;
$$;

revoke all on function public.sync_v2_require_member(text) from public, anon, authenticated;
revoke all on function public.sync_v2_require_admin(text) from public, anon, authenticated;
revoke all on function public.sync_v2_record_change(text, uuid, uuid, uuid, uuid, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.sync_v2_keys_allowed(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.sync_v2_payload_is_allowed(text, jsonb) from public, anon, authenticated;
revoke all on function public.sync_v2_open_conflict(text, uuid, text, text, text, jsonb, jsonb, jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function public.sync_v2_baseline_op_id(text) from public, anon, authenticated;
revoke all on function public.sync_v2_register_device(text, uuid, text, integer, integer, integer) from public, anon;
revoke all on function public.sync_v2_activate(text) from public, anon;
revoke all on function public.sync_v2_readiness(text) from public, anon;
revoke all on function public.sync_v2_apply(text, uuid, uuid, jsonb) from public, anon;
revoke all on function public.sync_v2_pull(text, uuid, bigint, integer) from public, anon;
revoke all on function public.sync_v2_snapshot(text, uuid) from public, anon;
revoke all on function public.sync_v2_resolve_conflict(uuid, text, jsonb) from public, anon;
grant execute on function public.sync_v2_register_device(text, uuid, text, integer, integer, integer) to authenticated;
grant execute on function public.sync_v2_activate(text) to authenticated;
grant execute on function public.sync_v2_readiness(text) to authenticated;
grant execute on function public.sync_v2_apply(text, uuid, uuid, jsonb) to authenticated;
grant execute on function public.sync_v2_pull(text, uuid, bigint, integer) to authenticated;
grant execute on function public.sync_v2_snapshot(text, uuid) to authenticated;
grant execute on function public.sync_v2_resolve_conflict(uuid, text, jsonb) to authenticated;

do $$
declare
  missing text[] := array[]::text[];
  required_table text;
  required_function regprocedure;
begin
  foreach required_table in array array[
    'sync_devices', 'sync_member_readiness', 'sync_changes', 'sync_operation_receipts',
    'sync_project_heads', 'coding_assignments', 'sync_conflicts'
  ] loop
    if not exists (
      select 1 from information_schema.tables
       where table_schema = 'public' and table_name = required_table
    ) then
      missing := array_append(missing, required_table);
    end if;
  end loop;
  foreach required_function in array array[
    'public.sync_v2_register_device(text,uuid,text,integer,integer,integer)'::regprocedure,
    'public.sync_v2_activate(text)'::regprocedure,
    'public.sync_v2_readiness(text)'::regprocedure,
    'public.sync_v2_apply(text,uuid,uuid,jsonb)'::regprocedure,
    'public.sync_v2_pull(text,uuid,bigint,integer)'::regprocedure,
    'public.sync_v2_snapshot(text,uuid)'::regprocedure,
    'public.sync_v2_resolve_conflict(uuid,text,jsonb)'::regprocedure
  ] loop
    if not exists (select 1 from pg_proc where oid = required_function and prosecdef) then
      missing := array_append(missing, required_function::text);
    elsif not has_function_privilege('authenticated', required_function, 'execute')
       or has_function_privilege('anon', required_function, 'execute')
       or has_function_privilege('public', required_function, 'execute') then
      missing := array_append(missing, required_function::text || ':privileges');
    end if;
  end loop;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'sync_project_heads'
  ) then
    missing := array_append(missing, 'supabase_realtime:sync_project_heads');
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name in ('sync_changes', 'sync_conflicts', 'coding_assignments')
       and column_name in ('memo', 'transcript', 'segment_text', 'quote_text', 'audio_path', 'raw_vtt_path', 'path')
  ) then
    missing := array_append(missing, 'forbidden_v2_content_column');
  end if;
  if cardinality(missing) > 0 then
    raise exception 'Cannot certify Codemap schema 10; missing: %', array_to_string(missing, ', ');
  end if;
end;
$$;

insert into public.server_meta (id, schema_version) values (1, 10)
on conflict (id) do update set schema_version = 10;

create or replace function public.server_schema_version()
returns integer language sql stable security definer set search_path = public
as $$ select schema_version from public.server_meta where id = 1 $$;

revoke execute on function public.server_schema_version() from public;
grant execute on function public.server_schema_version() to anon, authenticated;

notify pgrst, 'reload schema';
commit;
