-- Notification inbox cleanup: supervisors can dismiss stale till-action alerts;
-- submit_day_end clears a cashier "requested" flag once the day is counted.
-- Safe to re-run.

create or replace function public.resolve_till_action_request(
  p_id uuid,
  p_resolved_by uuid,
  p_status text,
  p_ack boolean default false
)
returns public.till_action_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.till_action_requests%rowtype;
begin
  if p_status not in ('approved', 'denied', 'self_allowed', 'cancelled') then
    raise exception 'TILL_ACT02: invalid status';
  end if;

  select * into v_row from public.till_action_requests where id = p_id for update;
  if not found then
    raise exception 'TILL_ACT03: request not found';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'TILL_ACT04: request already resolved';
  end if;

  if p_status = 'self_allowed' then
    if v_row.requested_by is distinct from p_resolved_by then
      raise exception 'TILL_ACT05: only requester can self-allow';
    end if;
    if p_ack is not true then
      raise exception 'TILL_ACT06: acknowledgment required';
    end if;
  elsif p_status in ('approved', 'denied') then
    if not (public.is_manager() or public.is_supervisor_or_above()) then
      raise exception 'TILL_ACT07: supervisor or manager required';
    end if;
    if p_resolved_by = v_row.requested_by then
      raise exception 'TILL_ACT08: cannot resolve your own request';
    end if;
  elsif p_status = 'cancelled' then
    if v_row.requested_by is distinct from p_resolved_by
       and not (public.is_manager() or public.is_supervisor_or_above()) then
      raise exception 'TILL_ACT09: only requester, supervisor, or manager can cancel';
    end if;
  end if;

  update public.till_action_requests
  set status = p_status,
      resolved_by = p_resolved_by,
      resolved_at = now(),
      self_record_ack = case when p_status = 'self_allowed' then true else self_record_ack end
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_resolved_by, 'till_action_' || p_status,
    v_row.detail,
    jsonb_build_object('till_action_id', v_row.id, 'action', v_row.action, 'status', p_status)
  );

  return v_row;
end;
$$;

-- Clear cashier request flags once the drawer is counted (requested → submitted path).
create or replace function public.submit_day_end(
  p_branch_id uuid,
  p_staff_id uuid,
  p_business_date date,
  p_recorded_cash numeric,
  p_cash_on_hand numeric,
  p_variance numeric,
  p_expected_cash numeric,
  p_note text default null,
  p_day_report jsonb default null,
  p_day_end_id uuid default null
)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized for this branch';
  end if;

  select * into v_row
  from day_ends
  where branch_id = p_branch_id
    and business_date = p_business_date
  for update;

  if found and v_row.status = 'closed' then
    raise exception 'Day is already closed';
  end if;

  if found then
    update day_ends
    set
      staff_id = p_staff_id,
      recorded_cash = p_recorded_cash,
      cash_on_hand = p_cash_on_hand,
      variance = p_variance,
      expected_cash = p_expected_cash,
      note = p_note,
      day_report = coalesce(p_day_report, day_report),
      status = 'submitted',
      submitted_at = now(),
      submitted_by = p_staff_id,
      approved_at = null,
      approved_by = null,
      closed_at = coalesce(closed_at, now()),
      requested_at = null,
      requested_by = null,
      request_manager = false,
      reopened_at = null,
      reopened_by = null,
      reopen_reason = null,
      reopen_requested_at = null,
      reopen_requested_by = null,
      reopen_request_reason = null
    where id = v_row.id
    returning * into v_row;
  else
    insert into day_ends (
      branch_id, staff_id, business_date,
      recorded_cash, cash_on_hand, variance, expected_cash,
      note, day_report, status,
      submitted_at, submitted_by, closed_at
    ) values (
      p_branch_id, p_staff_id, p_business_date,
      p_recorded_cash, p_cash_on_hand, p_variance, p_expected_cash,
      p_note, p_day_report, 'submitted',
      now(), p_staff_id, now()
    )
    returning * into v_row;
  end if;

  if public.is_supervisor_or_above() then
    return public.approve_day_end(v_row.id, p_staff_id);
  end if;

  return v_row;
end;
$$;

notify pgrst, 'reload schema';

-- Clear stale "request day end" flag after the drawer was already counted.
create or replace function public.clear_resolved_day_end_request(
  p_day_end_id uuid,
  p_staff_id uuid
)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'Only supervisors or managers can clear a day end request';
  end if;

  update public.day_ends
  set
    requested_at = null,
    requested_by = null,
    request_manager = false
  where id = p_day_end_id
    and (
      status in ('closed', 'submitted')
      or (status = 'requested' and (submitted_at is not null or closed_at is not null or approved_at is not null))
    )
  returning * into v_row;

  if not found then
    select * into v_row
    from public.day_ends
    where id = p_day_end_id
      and status = 'requested';

    if found and exists (
      select 1
      from public.audit_events ae
      where ae.branch_id = v_row.branch_id
        and ae.event_type = 'day_end_approved'
        and (
          (ae.meta->>'day_end_id')::uuid = p_day_end_id
          or ae.meta->>'business_date' = v_row.business_date::text
        )
    ) then
      update public.day_ends
      set
        status = 'closed',
        requested_at = null,
        requested_by = null,
        request_manager = false,
        approved_at = coalesce(approved_at, now()),
        approved_by = coalesce(approved_by, p_staff_id),
        closed_at = coalesce(closed_at, now())
      where id = p_day_end_id
      returning * into v_row;
    end if;
  end if;

  if not found then
    raise exception 'No resolved day end request to clear';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_request_cleared',
    'Cleared stale day end request for ' || v_row.business_date::text,
    jsonb_build_object('day_end_id', v_row.id, 'business_date', v_row.business_date)
  );

  return v_row;
end;
$$;

grant execute on function public.clear_resolved_day_end_request(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
