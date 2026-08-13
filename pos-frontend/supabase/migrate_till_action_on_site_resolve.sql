-- Let the cashier session close a pending cart-remove alert after on-site supervisor PIN.
--
-- WHY: the till modal runs under the cashier's auth token. dismissPendingTillActionsOnSite()
-- calls resolve_till_action_request with the supervisor's staff id as p_resolved_by, but the
-- old RPC only checked is_supervisor_or_above() on auth.uid() — the cashier — so TILL_ACT07
-- fired and the manager bell stayed stuck until someone hit Clear manually.
--
-- Apply after migrate_notification_cleanup.sql. Safe to re-run.

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

  if p_resolved_by = v_row.requested_by then
    raise exception 'TILL_ACT08: cannot resolve your own request';
  end if;

  if p_status = 'self_allowed' then
    if v_row.requested_by is distinct from p_resolved_by then
      raise exception 'TILL_ACT05: only requester can self-allow';
    end if;
    if p_ack is not true then
      raise exception 'TILL_ACT06: acknowledgment required';
    end if;
  elsif p_status in ('approved', 'denied') then
    if public.is_manager()
       or (
         public.is_supervisor_or_above()
         and public.current_staff_id() is distinct from v_row.requested_by
       ) then
      null;
    elsif p_status = 'approved'
      and public.current_staff_id() = v_row.requested_by
      and exists (
        select 1
        from public.staff s
        where s.id = p_resolved_by
          and s.branch_id = v_row.branch_id
          and s.is_active
          and s.role in ('supervisor', 'manager', 'admin', 'master')
      ) then
      -- Cashier till clearing the remote alert after an on-site supervisor PIN.
      null;
    else
      raise exception 'TILL_ACT07: supervisor or manager required';
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

notify pgrst, 'reload schema';
