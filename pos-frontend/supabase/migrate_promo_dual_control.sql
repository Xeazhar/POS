-- Promo dual-control: create and stop both require manager approval first

alter table promo_events add column if not exists status text;
alter table promo_events add column if not exists requested_by uuid references staff(id) on delete set null;
alter table promo_events add column if not exists approved_by uuid references staff(id) on delete set null;
alter table promo_events add column if not exists approved_at timestamptz;
alter table promo_events add column if not exists stop_requested_by uuid references staff(id) on delete set null;
alter table promo_events add column if not exists stop_reason text;
alter table promo_events add column if not exists stopped_by uuid references staff(id) on delete set null;
alter table promo_events add column if not exists stopped_at timestamptz;

-- Backfill status from is_active
update promo_events
set status = case when is_active then 'active' else 'stopped' end
where status is null;

alter table promo_events alter column status set default 'pending';
alter table promo_events drop constraint if exists promo_events_status_check;
alter table promo_events add constraint promo_events_status_check
  check (status in ('draft', 'pending', 'active', 'rejected', 'stop_pending', 'stopped'));

-- One active/stop_pending promo per branch (live on POS)
drop index if exists uq_promo_events_one_active_per_branch;
create unique index if not exists uq_promo_events_one_live_per_branch
  on promo_events(branch_id)
  where status in ('active', 'stop_pending');

create or replace function public.approve_promo_event(p_promo_event_id uuid, p_staff_id uuid)
returns public.promo_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.promo_events;
begin
  if not public.is_manager() then
    raise exception 'Only managers can approve promos';
  end if;

  -- Deactivate any currently live promo on this branch
  update promo_events pe
  set is_active = false,
      status = case when pe.status in ('active', 'stop_pending') then 'stopped' else pe.status end,
      stopped_at = coalesce(pe.stopped_at, now()),
      stopped_by = coalesce(pe.stopped_by, p_staff_id)
  from promo_events target
  where target.id = p_promo_event_id
    and pe.branch_id = target.branch_id
    and pe.id <> p_promo_event_id
    and pe.status in ('active', 'stop_pending');

  update promo_events
  set status = 'active',
      is_active = true,
      approved_by = p_staff_id,
      approved_at = now()
  where id = p_promo_event_id
    and status = 'pending'
  returning * into v_row;

  if not found then
    raise exception 'No pending promo found to approve';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'promo_approved',
    'Approved promo: ' || v_row.name,
    jsonb_build_object('promo_event_id', v_row.id)
  );

  return v_row;
end;
$$;

create or replace function public.reject_promo_event(p_promo_event_id uuid, p_staff_id uuid)
returns public.promo_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.promo_events;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reject promos';
  end if;

  update promo_events
  set status = 'rejected',
      is_active = false,
      approved_by = p_staff_id,
      approved_at = now()
  where id = p_promo_event_id
    and status = 'pending'
  returning * into v_row;

  if not found then
    raise exception 'No pending promo found to reject';
  end if;

  return v_row;
end;
$$;

create or replace function public.request_stop_promo(p_promo_event_id uuid, p_staff_id uuid, p_reason text)
returns public.promo_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.promo_events;
  v_reason text;
begin
  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Stop reason is required';
  end if;

  update promo_events
  set status = 'stop_pending',
      stop_requested_by = p_staff_id,
      stop_reason = v_reason
  where id = p_promo_event_id
    and status = 'active'
  returning * into v_row;

  if not found then
    raise exception 'Only an active promo can request stop';
  end if;

  -- Stay live on POS until stop is approved
  -- is_active remains true

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'promo_stop_requested',
    'Requested stop: ' || v_row.name || ' — ' || left(v_reason, 200),
    jsonb_build_object('promo_event_id', v_row.id, 'reason', v_reason)
  );

  return v_row;
end;
$$;

create or replace function public.approve_stop_promo(p_promo_event_id uuid, p_staff_id uuid)
returns public.promo_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.promo_events;
begin
  if not public.is_manager() then
    raise exception 'Only managers can approve promo stop';
  end if;

  update promo_events
  set status = 'stopped',
      is_active = false,
      stopped_by = p_staff_id,
      stopped_at = now()
  where id = p_promo_event_id
    and status = 'stop_pending'
  returning * into v_row;

  if not found then
    raise exception 'No stop-pending promo found';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'promo_stopped',
    'Approved stop: ' || v_row.name,
    jsonb_build_object('promo_event_id', v_row.id, 'reason', v_row.stop_reason)
  );

  return v_row;
end;
$$;

create or replace function public.reject_stop_promo(p_promo_event_id uuid, p_staff_id uuid)
returns public.promo_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.promo_events;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reject promo stop';
  end if;

  update promo_events
  set status = 'active',
      is_active = true,
      stop_requested_by = null,
      stop_reason = null
  where id = p_promo_event_id
    and status = 'stop_pending'
  returning * into v_row;

  if not found then
    raise exception 'No stop-pending promo found';
  end if;

  return v_row;
end;
$$;

grant execute on function public.approve_promo_event(uuid, uuid) to authenticated;
grant execute on function public.reject_promo_event(uuid, uuid) to authenticated;
grant execute on function public.request_stop_promo(uuid, uuid, text) to authenticated;
grant execute on function public.approve_stop_promo(uuid, uuid) to authenticated;
grant execute on function public.reject_stop_promo(uuid, uuid) to authenticated;
