-- Let a cashier close their own shift when no supervisor or manager can reach the till,
-- flagged for a manager to review afterward.
--
-- WHY
-- ---
-- ShiftCashOut.jsx now requires a supervisor (or manager) PIN before a shift closes —
-- someone has to witness the count. But the manager here is always remote: they cannot walk
-- over and type a PIN into this device, and reading a PIN out over the phone is not a control,
-- it is the same person approving themselves with extra steps. Without an escape hatch a
-- cashier could be stuck holding an uncounted drawer with no one able to close it.
--
-- This adds a checkbox path: the cashier ticks "no supervisor available", the shift closes
-- under their own count (closed_by = the cashier themselves), and it is flagged
-- `closed_without_supervisor` so a manager can review it later — remotely, whenever they next
-- have connectivity — and acknowledge it. This does not touch the normal path: any close where
-- p_closed_by is someone OTHER than the shift's own staff_id (the supervisor/manager PIN path)
-- is never flagged.
--
-- PREREQUISITE: migrate_shift_cash_accountability.sql (staff_shifts, close_staff_shift()).
--
-- Safe to re-run.

alter table public.staff_shifts add column if not exists closed_without_supervisor boolean not null default false;
alter table public.staff_shifts add column if not exists reviewed_by uuid references public.staff(id) on delete set null;
alter table public.staff_shifts add column if not exists reviewed_at timestamptz;

comment on column public.staff_shifts.closed_without_supervisor is
  'True when this shift was closed under its own cashier''s count because no supervisor/manager could witness it — needs a manager''s review.';
comment on column public.staff_shifts.reviewed_at is
  'When a manager acknowledged a closed_without_supervisor shift. Null = still needs review.';

create or replace function public.close_staff_shift(
  p_shift_id uuid,
  p_ending_cash numeric,
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
  v_expected numeric(12,2);
  v_row public.staff_shifts%rowtype;
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

  if v_shift.holds_drawer and (p_ending_cash is null or p_ending_cash < 0) then
    raise exception 'SHIFT_COUNT_REQUIRED: count the drawer before ending the shift';
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
      case when t.status = 'completed' then coalesce(t.refunded_amount, 0) else t.total_amount end
    ), 0)
  into v_sales, v_refunds
  from public.transactions t
  where t.shift_id = p_shift_id
    and coalesce(t.payment_method, 'cash') = 'cash';

  select
    coalesce(sum(case when c.kind = 'paid_out' and c.status = 'approved' then c.amount else 0 end), 0),
    coalesce(sum(case when c.kind = 'pickup' then c.amount else 0 end), 0)
  into v_paid_out, v_pickups
  from public.cash_drawer_entries c
  where c.shift_id = p_shift_id;

  v_expected := round(
    coalesce(v_shift.starting_cash, 0) + v_sales - v_refunds - v_paid_out - v_pickups, 2);

  update public.staff_shifts
  set clock_out = now(),
      ending_cash = round(p_ending_cash, 2),
      expected_cash = v_expected,
      variance = round(round(p_ending_cash, 2) - v_expected, 2),
      cash_sales = v_sales,
      cash_refunds = v_refunds,
      cash_paid_out = v_paid_out,
      cash_pickups = v_pickups,
      close_note = nullif(trim(coalesce(p_note, '')), ''),
      closed_by = coalesce(p_closed_by, staff_id),
      -- Flagged only when the closer IS the shift's own cashier — i.e. the "no supervisor
      -- available" path, never the normal PIN-witnessed close by someone else.
      closed_without_supervisor = (coalesce(p_closed_by, staff_id) = staff_id)
  where id = p_shift_id
  returning * into v_row;

  return v_row;
end $$;

grant execute on function public.close_staff_shift(uuid, numeric, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Manager acknowledges a flagged shift, remotely, whenever they get to it.
-- ---------------------------------------------------------------------------
create or replace function public.acknowledge_shift_review(
  p_shift_id uuid,
  p_staff_id uuid
)
returns public.staff_shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.staff_shifts%rowtype;
  v_row public.staff_shifts%rowtype;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'SHIFT_NOT_ALLOWED: only a supervisor or manager can acknowledge this';
  end if;

  select * into v_shift from public.staff_shifts where id = p_shift_id;
  if not found then
    raise exception 'SHIFT_NOT_FOUND: no shift with id %', p_shift_id;
  end if;

  if not (v_shift.branch_id = public.current_staff_branch() or public.is_manager()) then
    raise exception 'SHIFT_NOT_ALLOWED: that shift belongs to another branch';
  end if;

  if not v_shift.closed_without_supervisor then
    raise exception 'SHIFT_NOT_FLAGGED: this shift was not closed without a supervisor';
  end if;

  update public.staff_shifts
  set reviewed_by = p_staff_id,
      reviewed_at = now()
  where id = p_shift_id and reviewed_at is null
  returning * into v_row;

  if not found then
    raise exception 'SHIFT_ALREADY_REVIEWED: this shift was already acknowledged';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'shift_review_acknowledged',
    'Acknowledged unsupervised close for shift ' || v_row.id::text,
    jsonb_build_object('shift_id', v_row.id, 'staff_id', v_row.staff_id, 'variance', v_row.variance)
  );

  return v_row;
end $$;

grant execute on function public.acknowledge_shift_review(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
