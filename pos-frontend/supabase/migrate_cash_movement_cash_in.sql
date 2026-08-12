-- POS Open Drawer: cash entering the drawer (opening float + additional float).
-- Prerequisite: migrate_cash_movements.sql
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- Type constraint
-- ---------------------------------------------------------------------------
alter table public.cash_movements drop constraint if exists cash_movements_type_check;
alter table public.cash_movements
  add constraint cash_movements_type_check
  check (type in ('petty_cash', 'pickup', 'cash_in', 'opening_float'));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.cash_movement_type_allowed(p_type text)
returns boolean
language sql
immutable
as $$
  select p_type in ('petty_cash', 'pickup', 'cash_in', 'opening_float');
$$;

create or replace function public.validate_cash_movement_opening_float(p_shift_id uuid, p_type text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.staff_shifts%rowtype;
begin
  if p_type <> 'opening_float' then
    return;
  end if;
  select * into v_shift from public.staff_shifts where id = p_shift_id;
  if not found then
    raise exception 'MOVE05: shift not found';
  end if;
  if coalesce(v_shift.starting_cash, 0) > 0 then
    raise exception 'MOVE20: opening float only when shift has no float yet';
  end if;
end;
$$;

create or replace function public.apply_counted_cash_movement_effects(p_row public.cash_movements)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_row is null or not public.cash_movement_counts(p_row.status) then
    return;
  end if;
  if p_row.type = 'opening_float' then
    update public.staff_shifts
    set starting_cash = round(p_row.amount, 2)
    where id = p_row.shift_id
      and coalesce(starting_cash, 0) = 0;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPCs — recreate with cash-in types + opening-float side effect
-- ---------------------------------------------------------------------------
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
  if p_approved_by is null or p_approved_by = p_requested_by then
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
    v_row.branch_id, p_approved_by, 'cash_movement_approved',
    'Approved ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object(
      'cash_movement_id', v_row.id, 'type', v_row.type,
      'amount', v_row.amount, 'via', 'pin'
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

-- Expected cash: cash_in adds; opening_float updates starting_cash (not double-counted).
create or replace function public.close_staff_shift(
  p_shift_id uuid,
  p_ending_cash numeric default null,
  p_note text default null,
  p_closed_by uuid default null
)
returns public.staff_shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.staff_shifts%rowtype;
  v_sales numeric(12,2) := 0;
  v_refunds numeric(12,2) := 0;
  v_paid_out numeric(12,2) := 0;
  v_pickups numeric(12,2) := 0;
  v_cash_in numeric(12,2) := 0;
  v_expected numeric(12,2);
  v_row public.staff_shifts%rowtype;
  v_move_paid numeric(12,2) := 0;
  v_move_pick numeric(12,2) := 0;
begin
  select * into v_shift from public.staff_shifts where id = p_shift_id;
  if not found then
    raise exception 'SHIFT_NOT_FOUND: no shift with id %', p_shift_id;
  end if;

  if v_shift.branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'SHIFT_NOT_ALLOWED: that shift belongs to another branch';
  end if;

  if v_shift.clock_out is not null then
    return v_shift;
  end if;

  if not v_shift.holds_drawer then
    update public.staff_shifts
    set clock_out = now(),
        close_note = nullif(trim(coalesce(p_note, '')), ''),
        closed_by = coalesce(p_closed_by, staff_id)
    where id = p_shift_id
    returning * into v_row;
    return v_row;
  end if;

  select
    coalesce(sum(case when t.status = 'completed' then t.total_amount else 0 end), 0),
    coalesce(sum(
      case when t.status = 'completed' then coalesce(t.refunded_amount, 0) else 0 end
    ), 0)
  into v_sales, v_refunds
  from public.transactions t
  where t.shift_id = p_shift_id
    and coalesce(t.payment_method, 'cash') = 'cash';

  select
    coalesce(sum(case when c.kind = 'paid_out' and c.status = 'fulfilled' then c.amount else 0 end), 0),
    coalesce(sum(case when c.kind = 'pickup' then c.amount else 0 end), 0)
  into v_paid_out, v_pickups
  from public.cash_drawer_entries c
  where c.shift_id = p_shift_id;

  select
    coalesce(sum(case when m.type = 'petty_cash' then m.amount else 0 end), 0),
    coalesce(sum(case when m.type = 'pickup' then m.amount else 0 end), 0),
    coalesce(sum(case when m.type = 'cash_in' then m.amount else 0 end), 0)
  into v_move_paid, v_move_pick, v_cash_in
  from public.cash_movements m
  where m.shift_id = p_shift_id
    and public.cash_movement_counts(m.status);

  v_paid_out := v_paid_out + v_move_paid;
  v_pickups := v_pickups + v_move_pick;

  v_expected := round(
    coalesce(v_shift.starting_cash, 0) + v_cash_in + v_sales - v_refunds - v_paid_out - v_pickups, 2);

  update public.staff_shifts
  set clock_out = now(),
      ending_cash = case when p_ending_cash is null then null else round(p_ending_cash, 2) end,
      expected_cash = case when p_ending_cash is null then null else v_expected end,
      variance = case when p_ending_cash is null then null else round(round(p_ending_cash, 2) - v_expected, 2) end,
      cash_sales = v_sales,
      cash_refunds = v_refunds,
      cash_paid_out = v_paid_out,
      cash_pickups = v_pickups,
      close_note = nullif(trim(coalesce(p_note, '')), ''),
      closed_by = coalesce(p_closed_by, staff_id)
  where id = p_shift_id
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.shift_cash_summary(p_shift_id uuid)
returns table (
  starting_cash numeric,
  cash_sales numeric,
  cash_refunds numeric,
  cash_paid_out numeric,
  cash_pickups numeric,
  expected_cash numeric,
  sale_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select * from public.staff_shifts
    where id = p_shift_id
      and (
        staff_id = public.current_staff_id()
        or public.is_manager()
        or (public.is_supervisor_or_above() and branch_id = public.current_staff_branch())
      )
  ),
  t as (
    select
      coalesce(sum(case when status = 'completed' then total_amount else 0 end), 0) as sales,
      coalesce(sum(case when status = 'completed' then coalesce(refunded_amount, 0) else 0 end), 0) as refunds,
      count(*) filter (where status = 'completed') as sale_count
    from public.transactions
    where shift_id = p_shift_id and coalesce(payment_method, 'cash') = 'cash'
  ),
  c as (
    select
      coalesce(sum(case when kind = 'paid_out' and status = 'fulfilled' then amount else 0 end), 0) as paid_out,
      coalesce(sum(case when kind = 'pickup' then amount else 0 end), 0) as pickups
    from public.cash_drawer_entries
    where shift_id = p_shift_id
  ),
  m as (
    select
      coalesce(sum(case when type = 'petty_cash' then amount else 0 end), 0) as paid_out,
      coalesce(sum(case when type = 'pickup' then amount else 0 end), 0) as pickups,
      coalesce(sum(case when type = 'cash_in' then amount else 0 end), 0) as cash_in
    from public.cash_movements
    where shift_id = p_shift_id
      and public.cash_movement_counts(status)
  )
  select
    coalesce(s.starting_cash, 0),
    t.sales,
    t.refunds,
    c.paid_out + m.paid_out,
    c.pickups + m.pickups,
    round(
      coalesce(s.starting_cash, 0) + m.cash_in + t.sales - t.refunds
      - (c.paid_out + m.paid_out) - (c.pickups + m.pickups),
      2
    ),
    t.sale_count::integer
  from s, t, c, m;
$$;

notify pgrst, 'reload schema';
