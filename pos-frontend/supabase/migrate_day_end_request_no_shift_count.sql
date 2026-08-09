-- Move cash counting from per-SHIFT to per-DAY, and let a cashier request a day end.
--
-- WHY
-- ---
-- Cash accountability used to be per shift: every cashier counted an ending float and a
-- supervisor PIN-verified it before the shift could close, and a new cashier was blocked
-- ("drawer still open") until that happened. In practice a branch has exactly one drawer,
-- and that per-shift friction was causing confusion rather than preventing loss. This
-- migration moves the ONE cash count of the day to Day End itself:
--   - Ending a shift is now just a clock-out. No count, no PIN.
--   - A new shift on a drawer that still has one open under someone else auto-closes the
--     stale one (no count) instead of blocking.
--   - A cashier can flag "Request day end" (no numbers) which notifies a supervisor, or —
--     via a toggle — a manager directly. Whoever answers it counts the drawer once, on the
--     existing Day End / Close Day screen, exactly as a supervisor does today.
--
-- Accepted tradeoff: a day-end variance can no longer be pinned to a specific cashier when
-- more than one worked the drawer that day with no per-shift counts — only to whoever
-- counted at close. This is intentional for a single-drawer branch.
--
-- Side effect: closed_without_supervisor (migrate_shift_close_no_supervisor_flag.sql) goes
-- dormant. It used to flag the rare case of a cashier closing under their own count; now
-- EVERY shift closes under its own cashier's clock-out, so this migration stops setting
-- that flag at all (left at its column default, false) rather than have it fire on every
-- single shift close. fetchPendingApprovals' "shift closed without supervisor" section and
-- acknowledge_shift_review() are unused going forward but left in place — harmless, and
-- removing them is a separate cleanup, not part of this change.
--
-- PREREQUISITES:
--   migrate_shift_cash_accountability.sql       (staff_shifts, open_staff_shift, close_staff_shift)
--   migrate_shift_close_no_supervisor_flag.sql   (closed_without_supervisor column — superseded here)
--   migrate_day_end_supervisor_autoclose.sql     (submit_day_end auto-close-on-supervisor+)
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. day_ends: a lightweight "requested, not counted yet" state
-- ---------------------------------------------------------------------------
alter table public.day_ends add column if not exists requested_at timestamptz;
alter table public.day_ends add column if not exists requested_by uuid references public.staff(id) on delete set null;
alter table public.day_ends add column if not exists request_manager boolean not null default false;

comment on column public.day_ends.requested_at is 'When a cashier flagged this business day for closing. Null once nobody has requested it yet.';
comment on column public.day_ends.request_manager is 'True when the cashier specifically asked for a manager (no supervisor available) rather than either supervisor+ picking it up.';

alter table public.day_ends drop constraint if exists day_ends_status_check;
alter table public.day_ends add constraint day_ends_status_check
  check (status in ('requested', 'submitted', 'closed', 'reopened'));

-- 'requested' deliberately does NOT lock the till — assert_till_open() only blocks on
-- ('closed', 'submitted'), so no change is needed there; a request is a notification, not
-- a lock.

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
  -- Same trust level as submit_day_end: any branch-matched authenticated staff member
  -- (cashiers included) may request a day end — approving/closing it still requires
  -- supervisor+ via approve_day_end / submit_day_end's auto-close.
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
        request_manager = coalesce(p_request_manager, false)
    where id = v_row.id
    returning * into v_row;
    return v_row;
  end if;

  insert into day_ends (
    branch_id, staff_id, business_date, status,
    requested_at, requested_by, request_manager
  ) values (
    p_branch_id, p_staff_id, p_business_date, 'requested',
    now(), p_staff_id, coalesce(p_request_manager, false)
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.request_day_end(uuid, uuid, date, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Ending a shift no longer requires a cash count
-- ---------------------------------------------------------------------------
-- Same signature as migrate_shift_cash_accountability.sql's close_staff_shift (arg types
-- unchanged, so CREATE OR REPLACE applies in place — existing grants carry over). The only
-- behavioural change: a drawer-holding shift with p_ending_cash = null now closes with
-- ending_cash/expected_cash/variance left null, instead of raising SHIFT_COUNT_REQUIRED.
-- cash_sales/cash_refunds/cash_paid_out/cash_pickups are still computed and stored — they
-- feed Day End's "Change fund by shift" totals and reports, independent of whether anyone
-- counted the physical drawer at shift-close time.
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
      ending_cash = case when p_ending_cash is null then null else round(p_ending_cash, 2) end,
      expected_cash = case when p_ending_cash is null then null else v_expected end,
      variance = case when p_ending_cash is null then null else round(round(p_ending_cash, 2) - v_expected, 2) end,
      cash_sales = v_sales,
      cash_refunds = v_refunds,
      cash_paid_out = v_paid_out,
      cash_pickups = v_pickups,
      close_note = nullif(trim(coalesce(p_note, '')), ''),
      closed_by = coalesce(p_closed_by, staff_id)
      -- closed_without_supervisor intentionally NOT set here (stays at its default,
      -- false) — see file header.
  where id = p_shift_id
  returning * into v_row;

  return v_row;
end $$;

grant execute on function public.close_staff_shift(uuid, numeric, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. A new shift is never blocked by a stale one on the same drawer
-- ---------------------------------------------------------------------------
-- Same signature as migrate_shift_cash_accountability.sql's open_staff_shift. Only change:
-- the SHIFT_DRAWER_BUSY branch no longer raises — it auto-closes the stale shift (no
-- count; ending a shift never counts anymore, see above) so the partial unique index
-- (branch_id, drawer_id) WHERE clock_out is null AND holds_drawer is satisfied again
-- before the new row is inserted, all inside this one transaction.
create or replace function public.open_staff_shift(
  p_branch_id uuid,
  p_staff_id uuid,
  p_drawer_id text,
  p_starting_cash numeric,
  p_shift_period text default null,
  p_client_id text default null,
  p_carried_from uuid default null,
  p_carried_amount numeric default null,
  p_business_date date default null,
  p_drawer_label text default null,
  p_holds_drawer boolean default true
)
returns public.staff_shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_drawer text := coalesce(nullif(trim(p_drawer_id), ''), 'main');
  v_holds boolean := coalesce(p_holds_drawer, true);
  v_existing public.staff_shifts%rowtype;
  v_row public.staff_shifts%rowtype;
begin
  if p_staff_id is distinct from public.current_staff_id()
     and not public.is_manager()
     and not (public.is_supervisor_or_above() and p_branch_id = public.current_staff_branch()) then
    raise exception 'SHIFT_NOT_ALLOWED: you can only start your own shift';
  end if;

  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'SHIFT_NOT_ALLOWED: that branch is not yours';
  end if;

  if v_holds and (p_starting_cash is null or p_starting_cash < 0) then
    raise exception 'SHIFT_FLOAT_REQUIRED: enter the change fund counted into the drawer';
  end if;

  if p_client_id is not null then
    select * into v_existing from public.staff_shifts where client_id = p_client_id limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  select * into v_existing
  from public.staff_shifts
  where staff_id = p_staff_id and branch_id = p_branch_id and drawer_id = v_drawer
    and clock_out is null
  limit 1;
  if found then
    return v_existing;
  end if;

  if v_holds then
    select * into v_existing
    from public.staff_shifts
    where branch_id = p_branch_id and drawer_id = v_drawer and clock_out is null and holds_drawer
    limit 1;
    if found then
      -- Was: raise SHIFT_DRAWER_BUSY. Now: auto-close it, no count required — the next
      -- cashier taking the drawer is no longer blocked by whoever forgot (or didn't need)
      -- to formally end their shift.
      update public.staff_shifts
      set clock_out = now(),
          close_note = 'Auto-closed: next cashier started a shift on this drawer',
          closed_by = p_staff_id
      where id = v_existing.id;
    end if;
  end if;

  insert into public.staff_shifts (
    branch_id, staff_id, drawer_id, drawer_label, holds_drawer, clock_in, shift_period,
    business_date, starting_cash, carried_from_shift_id, carried_amount, client_id
  ) values (
    p_branch_id, p_staff_id, v_drawer, nullif(trim(coalesce(p_drawer_label, '')), ''), v_holds, now(),
    case when p_shift_period in ('am', 'pm') then p_shift_period else null end,
    coalesce(p_business_date, (timezone('Asia/Manila', now()))::date),
    case when v_holds then round(p_starting_cash, 2) else null end,
    p_carried_from, round(coalesce(p_carried_amount, 0), 2),
    nullif(trim(coalesce(p_client_id, '')), '')
  )
  returning * into v_row;

  return v_row;
end $$;

grant execute on function public.open_staff_shift(uuid, uuid, text, numeric, text, text, uuid, numeric, date, text, boolean) to authenticated;

notify pgrst, 'reload schema';
