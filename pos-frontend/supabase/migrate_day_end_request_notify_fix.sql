-- Fix: cashier "Request day end" never reaches the manager/supervisor bell.
--
-- day_ends.closed_at was NOT NULL DEFAULT now(). request_day_end() inserts without
-- setting closed_at, so every new request got closed_at = now(). The inbox query
-- filters closed_at IS NULL, and reconcile treated closed_at as "already counted"
-- and cleared/rejected the request — so supervisors/managers never saw the notify.
--
-- Apply after migrate_day_end_request_no_shift_count.sql (+ reject / notification_cleanup).
-- Safe to re-run.

-- 1. Allow open / requested days to have no close timestamp
alter table public.day_ends
  alter column closed_at drop not null;

alter table public.day_ends
  alter column closed_at drop default;

-- Existing pending requests: clear the bogus default close time
update public.day_ends
set closed_at = null
where status = 'requested'
  and submitted_at is null
  and approved_at is null;

-- 2. request_day_end: always clear close/submit stamps on a live request
create or replace function public.request_day_end(
  p_branch_id uuid,
  p_staff_id uuid,
  p_business_date date,
  p_request_manager boolean default false
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

  if found and v_row.status in ('submitted', 'closed') then
    raise exception 'Day end is already % for this business date', v_row.status;
  end if;

  if found then
    update day_ends
    set status = 'requested',
        requested_at = now(),
        requested_by = p_staff_id,
        request_manager = coalesce(p_request_manager, false),
        submitted_at = null,
        submitted_by = null,
        approved_at = null,
        approved_by = null,
        closed_at = null
    where id = v_row.id
    returning * into v_row;
    return v_row;
  end if;

  insert into day_ends (
    branch_id, staff_id, business_date, status,
    requested_at, requested_by, request_manager,
    closed_at, submitted_at, approved_at
  ) values (
    p_branch_id, p_staff_id, p_business_date, 'requested',
    now(), p_staff_id, coalesce(p_request_manager, false),
    null, null, null
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.request_day_end(uuid, uuid, date, boolean) to authenticated;

-- 3. Do not treat closed_at alone as "already counted" while status is still requested
--    (that matched the bogus default and wiped live requests on bell refresh).
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
      or (status = 'requested' and (submitted_at is not null or approved_at is not null))
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

  return v_row;
end;
$$;

grant execute on function public.clear_resolved_day_end_request(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
