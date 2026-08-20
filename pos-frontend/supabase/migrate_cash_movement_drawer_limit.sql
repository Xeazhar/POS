-- Block a petty cash / pickup movement (request, approve, or self-record) that would take
-- more cash out than the drawer currently holds. Before this, a cashier or supervisor could
-- enter e.g. a ₱1,000 pickup against a drawer that only has ₱500 (change fund + cash sales
-- so far), leaving expected_cash negative — nothing on the way in or out of cash_movements
-- checked the running balance, only that amount > 0.
--
-- cash_in / opening_float are untouched: they add cash, so there's nothing to block.
--
-- Prerequisite: migrate_cash_movement_cash_in.sql (supersedes create_cash_movement_pending /
-- approve_cash_movement_pin / approve_cash_movement_manager / self_record_cash_movement) and
-- migrate_cash_movement_self_approve.sql (supersedes create_cash_movement_approved). Bodies
-- below are those files' bodies, unchanged except for the added
-- validate_cash_movement_outflow() call.
-- Safe to re-run.

create or replace function public.validate_cash_movement_outflow(
  p_shift_id uuid,
  p_type text,
  p_amount numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_available numeric;
begin
  if p_type not in ('petty_cash', 'pickup') then
    return;
  end if;

  select expected_cash into v_available from public.shift_cash_summary(p_shift_id);
  if v_available is null then
    raise exception 'MOVE05: shift not found';
  end if;

  if p_amount > v_available then
    raise exception 'MOVE24: amount exceeds the ₱% currently in the drawer', to_char(v_available, 'FM999999990.00');
  end if;
end;
$$;
-- Hardened: internal helper called only from the cash-movement RPCs below, same treatment
-- as validate_cash_movement_opening_float (migrate_revoke_cash_movement_internal_grants.sql).
revoke execute on function public.validate_cash_movement_outflow(uuid, text, numeric) from public;
revoke execute on function public.validate_cash_movement_outflow(uuid, text, numeric) from authenticated;

create or replace function public.create_cash_movement_approved(
  p_shift_id uuid,
  p_branch_id uuid,
  p_drawer_id text,
  p_drawer_label text,
  p_type text,
  p_amount numeric,
  p_reason text,
  p_requested_by uuid,
  p_approved_by uuid,
  p_client_id uuid default null,
  p_created_offline boolean default false
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.staff_shifts%rowtype;
  v_row public.cash_movements%rowtype;
  v_self_approved boolean;
begin
  if not public.cash_movement_type_allowed(p_type) then
    raise exception 'MOVE01: invalid movement type';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'MOVE02: amount must be positive';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'MOVE03: reason is required';
  end if;
  if p_approved_by is null then
    raise exception 'MOVE04: supervisor approval required';
  end if;
  -- Null-safe: `=` against a null p_requested_by yields NULL, which the `and` below then
  -- silently treats as false rather than skipping the dual-control check — same reasoning
  -- as the branch_id/staff_id `is distinct from` checks a few lines down.
  v_self_approved := p_approved_by is not distinct from p_requested_by;
  if v_self_approved and not public.is_supervisor_or_above() then
    raise exception 'MOVE04: supervisor approval required';
  end if;

  select * into v_shift from public.staff_shifts where id = p_shift_id for update;
  if not found then
    raise exception 'MOVE05: shift not found';
  end if;
  if v_shift.clock_out is not null then
    raise exception 'MOVE06: shift is closed';
  end if;
  if v_shift.holds_drawer is false then
    raise exception 'MOVE07: floor shift cannot hold drawer cash';
  end if;
  if v_shift.branch_id is distinct from p_branch_id then
    raise exception 'MOVE08: branch mismatch';
  end if;
  if v_shift.staff_id is distinct from p_requested_by
     and not public.is_supervisor_or_above() then
    raise exception 'MOVE09: only the drawer holder can request';
  end if;

  perform public.validate_cash_movement_opening_float(p_shift_id, p_type);
  perform public.validate_cash_movement_outflow(p_shift_id, p_type, p_amount);

  insert into public.cash_movements (
    client_id, shift_id, branch_id, drawer_id, drawer_label,
    type, amount, reason, requested_by, status,
    approved_by, approved_at, created_offline, synced_at
  ) values (
    p_client_id, p_shift_id, p_branch_id,
    coalesce(nullif(trim(p_drawer_id), ''), 'main'),
    coalesce(nullif(trim(p_drawer_label), ''), 'Main drawer'),
    p_type, round(p_amount, 2), trim(p_reason), p_requested_by, 'approved',
    p_approved_by, now(), coalesce(p_created_offline, false),
    case when coalesce(p_created_offline, false) then null else now() end
  )
  returning * into v_row;

  perform public.apply_counted_cash_movement_effects(v_row);

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_approved_by,
    case when v_self_approved then 'cash_movement_self_approved' else 'cash_movement_approved' end,
    (case when v_self_approved then 'Self-approved ' else 'Approved ' end)
      || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object(
      'cash_movement_id', v_row.id, 'type', v_row.type,
      'amount', v_row.amount, 'via', case when v_self_approved then 'self' else 'pin' end
    )
  );

  return v_row;
end;
$$;

create or replace function public.create_cash_movement_pending(
  p_shift_id uuid,
  p_branch_id uuid,
  p_drawer_id text,
  p_drawer_label text,
  p_type text,
  p_amount numeric,
  p_reason text,
  p_requested_by uuid,
  p_client_id uuid default null,
  p_created_offline boolean default false
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.staff_shifts%rowtype;
  v_row public.cash_movements%rowtype;
begin
  if not public.cash_movement_type_allowed(p_type) then
    raise exception 'MOVE01: invalid movement type';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'MOVE02: amount must be positive';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'MOVE03: reason is required';
  end if;

  select * into v_shift from public.staff_shifts where id = p_shift_id for update;
  if not found then
    raise exception 'MOVE05: shift not found';
  end if;
  if v_shift.clock_out is not null then
    raise exception 'MOVE06: shift is closed';
  end if;
  if v_shift.holds_drawer is false then
    raise exception 'MOVE07: floor shift cannot hold drawer cash';
  end if;
  if v_shift.branch_id is distinct from p_branch_id then
    raise exception 'MOVE08: branch mismatch';
  end if;

  perform public.validate_cash_movement_opening_float(p_shift_id, p_type);
  perform public.validate_cash_movement_outflow(p_shift_id, p_type, p_amount);

  insert into public.cash_movements (
    client_id, shift_id, branch_id, drawer_id, drawer_label,
    type, amount, reason, requested_by, status,
    created_offline, synced_at
  ) values (
    p_client_id, p_shift_id, p_branch_id,
    coalesce(nullif(trim(p_drawer_id), ''), 'main'),
    coalesce(nullif(trim(p_drawer_label), ''), 'Main drawer'),
    p_type, round(p_amount, 2), trim(p_reason), p_requested_by, 'pending_remote',
    coalesce(p_created_offline, false),
    case when coalesce(p_created_offline, false) then null else now() end
  )
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_requested_by, 'cash_movement_pending',
    'Requested manager approval for ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object(
      'cash_movement_id', v_row.id, 'type', v_row.type, 'amount', v_row.amount
    )
  );

  return v_row;
end;
$$;

create or replace function public.approve_cash_movement_pin(
  p_id uuid,
  p_approved_by uuid
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cash_movements%rowtype;
begin
  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;
  if p_approved_by is null or p_approved_by = v_row.requested_by then
    raise exception 'MOVE04: supervisor approval required';
  end if;

  perform public.validate_cash_movement_opening_float(v_row.shift_id, v_row.type);
  perform public.validate_cash_movement_outflow(v_row.shift_id, v_row.type, v_row.amount);

  update public.cash_movements
  set status = 'approved',
      approved_by = p_approved_by,
      approved_at = now()
  where id = p_id
  returning * into v_row;

  perform public.apply_counted_cash_movement_effects(v_row);

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_approved_by, 'cash_movement_approved',
    'PIN-approved ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id, 'via', 'pin')
  );

  return v_row;
end;
$$;

create or replace function public.approve_cash_movement_manager(
  p_id uuid,
  p_approved_by uuid
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cash_movements%rowtype;
begin
  if not public.is_manager() then
    raise exception 'MOVE12: only managers can remotely approve';
  end if;

  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;
  if p_approved_by is null then
    raise exception 'MOVE04: approver required';
  end if;

  perform public.validate_cash_movement_opening_float(v_row.shift_id, v_row.type);
  perform public.validate_cash_movement_outflow(v_row.shift_id, v_row.type, v_row.amount);

  update public.cash_movements
  set status = 'remote_approved',
      approved_by = p_approved_by,
      approved_at = now()
  where id = p_id
  returning * into v_row;

  perform public.apply_counted_cash_movement_effects(v_row);

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_approved_by, 'cash_movement_remote_approved',
    'Remote-approved ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id, 'via', 'manager')
  );

  return v_row;
end;
$$;

create or replace function public.self_record_cash_movement(
  p_id uuid,
  p_staff_id uuid,
  p_ack boolean
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cash_movements%rowtype;
begin
  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;
  if v_row.requested_by is distinct from p_staff_id then
    raise exception 'MOVE14: only the requester can self-record';
  end if;
  if p_ack is not true then
    raise exception 'MOVE15: acknowledgment required';
  end if;
  if nullif(trim(coalesce(v_row.reason, '')), '') is null then
    raise exception 'MOVE03: reason is required';
  end if;

  perform public.validate_cash_movement_opening_float(v_row.shift_id, v_row.type);
  perform public.validate_cash_movement_outflow(v_row.shift_id, v_row.type, v_row.amount);

  update public.cash_movements
  set status = 'self_recorded',
      self_record_ack = true,
      self_recorded_at = now()
  where id = p_id
  returning * into v_row;

  perform public.apply_counted_cash_movement_effects(v_row);

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'cash_movement_self_recorded',
    'Self-recorded ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id)
  );

  return v_row;
end;
$$;

notify pgrst, 'reload schema';
