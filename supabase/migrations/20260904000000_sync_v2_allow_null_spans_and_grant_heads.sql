-- ─────────────────────────────────────────────────────────────────────────────
-- 20260904000000: Sync Protocol 2 whole-turn null spans and Realtime heads grant
--
-- Additive migration for Fleuron 2.5.0. Server schema certification stays at
-- version 10 so the installed base keeps syncing.
--
-- 1. Permits whole-turn coding operations where char_start and char_end are
--    both omitted (2.5.0+ client format) or both explicit JSON nulls (2.4.x
--    client format queued in outbox).
-- 2. Restores table-level SELECT on public.sync_project_heads for authenticated,
--    enabling Realtime postgres_changes subscriptions while keeping RLS
--    member-only protection intact.
-- ─────────────────────────────────────────────────────────────────────────────
begin;

-- ── 1. Update public.sync_v2_payload_is_allowed ──────────────────────────────
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
      if edge ? 'char_start' then
        if jsonb_typeof(edge->'char_start') = 'null'
           and jsonb_typeof(edge->'char_end') = 'null' then
          null; -- 2.4.x whole-turn encoding
        elsif jsonb_typeof(edge->'char_start') <> 'number'
           or jsonb_typeof(edge->'char_end') <> 'number'
           or (edge->>'char_start')::integer < 0
           or (edge->>'char_end')::integer <= (edge->>'char_start')::integer then
          return false;
        end if;
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

-- ── 2. Realtime SELECT privilege for sync_project_heads ──────────────────────
grant select on table public.sync_project_heads to authenticated;

commit;
