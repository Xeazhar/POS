-- Per-shift change fund (starting cash) and drawer accountability.
--
-- WHY
-- ---
-- One branch, one physical drawer, several cashiers in a day. Before this, the opening
-- float was recorded per business day, so a shortage at close could not be pinned to the
-- cashier who was actually holding the drawer when it happened. This makes the SHIFT the
-- unit of cash accountability: each shift carries its own starting count, its own sales,
-- its own ending count and its own variance.
--
-- PREREQUISITES — apply these first if you have not already:
--   migrate_staff_pin_payments_roles_finance.sql   (staff_shifts, is_supervisor_or_above)
--   migrate_cash_accountability_controls.sql       (cash_drawer_entries.kind/status/shift_id)
--   migrate_refund_amount_on_transactions.sql      (transactions.refunded_amount)
--   migrate_staff_pin_payments_roles_finance.sql   (transactions.payment_method)
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 0. Fail early and clearly rather than half-applying.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.staff_shifts') is null then
    raise exception 'staff_shifts is missing — apply migrate_staff_pin_payments_roles_finance.sql first';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'transactions' and column_name = 'refunded_amount'
  ) then
    raise exception 'transactions.refunded_amount is missing — apply migrate_refund_amount_on_transactions.sql first';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'transactions' and column_name = 'payment_method'
  ) then
    raise exception 'transactions.payment_method is missing — apply migrate_staff_pin_payments_roles_finance.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Shift columns
-- ---------------------------------------------------------------------------
-- drawer_id identifies the physical till/terminal. Branches with one drawer keep the
-- default 'main' and never notice this column exists; the column is what makes "two
-- cashiers cannot both hold the same drawer" expressible at all.
alter table public.staff_shifts add column if not exists drawer_id text not null default 'main';
alter table public.staff_shifts add column if not exists drawer_label text;
-- Not every shift holds cash. A supervisor on the floor works the same hours but is not
-- accountable for a drawer, so their shift is exempt from both the change-fund count and
-- the one-shift-per-drawer rule — otherwise a supervisor clocking in would lock the
-- cashier out of the till they are actually standing at.
alter table public.staff_shifts add column if not exists holds_drawer boolean not null default true;
alter table public.staff_shifts add column if not exists business_date date;
alter table public.staff_shifts add column if not exists starting_cash numeric(12,2);
alter table public.staff_shifts add column if not exists carried_from_shift_id uuid references public.staff_shifts(id) on delete set null;
alter table public.staff_shifts add column if not exists carried_amount numeric(12,2);
alter table public.staff_shifts add column if not exists ending_cash numeric(12,2);
alter table public.staff_shifts add column if not exists expected_cash numeric(12,2);
alter table public.staff_shifts add column if not exists variance numeric(12,2);
alter table public.staff_shifts add column if not exists cash_sales numeric(12,2);
alter table public.staff_shifts add column if not exists cash_refunds numeric(12,2);
alter table public.staff_shifts add column if not exists cash_paid_out numeric(12,2);
alter table public.staff_shifts add column if not exists cash_pickups numeric(12,2);
alter table public.staff_shifts add column if not exists close_note text;
alter table public.staff_shifts add column if not exists closed_by uuid references public.staff(id) on delete set null;
-- client_id is how an offline "start shift" survives a retry: the device generates it, so
-- the same push arriving twice updates one row instead of opening a second shift.
alter table public.staff_shifts add column if not exists client_id text;

comment on column public.staff_shifts.drawer_id is 'Physical drawer/terminal this shift held. One open shift per (branch, drawer).';
comment on column public.staff_shifts.starting_cash is 'Change fund counted into the drawer at shift start.';
comment on column public.staff_shifts.carried_from_shift_id is 'Previous shift on this drawer whose ending count pre-filled the start count (handoff).';
comment on column public.staff_shifts.variance is 'ending_cash - expected_cash. Negative = short.';

update public.staff_shifts
set business_date = (timezone('Asia/Manila', clock_in))::date
where business_date is null;

-- ---------------------------------------------------------------------------
-- 2. Sales attribution
-- ---------------------------------------------------------------------------
alter table public.transactions add column if not exists shift_id uuid references public.staff_shifts(id) on delete set null;
create index if not exists idx_transactions_shift on public.transactions (shift_id) where shift_id is not null;

comment on column public.transactions.shift_id is 'Shift that rang this sale. Lets cash be rolled up per shift as well as per day.';

-- ---------------------------------------------------------------------------
-- 3. One open shift per drawer
-- ---------------------------------------------------------------------------
-- Pre-existing data can already violate this (the old flow allowed any number of open
-- shifts, and every existing row inherits drawer_id 'main'). Close the stale ones — keep
-- the newest per drawer — before adding the index, otherwise the index creation fails and
-- nothing else in this file applies.
--
-- EXPECT THIS TO CLOSE SOMETHING on first apply if staff are mid-shift: anyone still
-- clocked in on the same branch other than the most recent person is clocked out here,
-- with a note saying why. Apply outside trading hours if you can.
with ranked as (
  select id,
         row_number() over (partition by branch_id, drawer_id order by clock_in desc) as rn
  from public.staff_shifts
  where clock_out is null and holds_drawer
)
update public.staff_shifts s
set clock_out = s.clock_in,
    close_note = coalesce(s.close_note, '') ||
      case when coalesce(s.close_note, '') = '' then '' else ' · ' end ||
      'Auto-closed by migrate_shift_cash_accountability.sql (drawer had multiple open shifts)'
from ranked r
where r.id = s.id and r.rn > 1;

create unique index if not exists uq_staff_shifts_open_drawer
  on public.staff_shifts (branch_id, drawer_id)
  where clock_out is null and holds_drawer;

create unique index if not exists uq_staff_shifts_client_id
  on public.staff_shifts (client_id)
  where client_id is not null;

create index if not exists idx_staff_shifts_branch_date
  on public.staff_shifts (branch_id, business_date desc);

create index if not exists idx_staff_shifts_open_staff
  on public.staff_shifts (staff_id, drawer_id)
  where clock_out is null;

comment on column public.staff_shifts.holds_drawer is 'True when this shift is accountable for a cash drawer (cashier). False for floor shifts (supervisor).';

-- ---------------------------------------------------------------------------
-- 4. Corrections are logged, never silent
-- ---------------------------------------------------------------------------
-- BIR sale-immutability applies to the cash record too: a supervisor who spots a
-- mis-keyed count does not overwrite it, they record an adjustment and the original
-- number stays readable.
create table if not exists public.shift_adjustments (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.staff_shifts(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete cascade,
  field text not null check (field in ('starting_cash', 'ending_cash')),
  old_value numeric(12,2),
  new_value numeric(12,2) not null,
  reason text not null,
  adjusted_by uuid references public.staff(id) on delete set null,
  approved_by uuid references public.staff(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_shift_adjustments_shift on public.shift_adjustments (shift_id, created_at desc);

alter table public.shift_adjustments enable row level security;

drop policy if exists "read shift adjustments" on public.shift_adjustments;
create policy "read shift adjustments" on public.shift_adjustments
  for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());

-- Insert only through adjust_shift_cash() below, which is SECURITY DEFINER — no direct
-- writes, so an adjustment row can never exist without the shift edit it justifies.
drop policy if exists "write shift adjustments" on public.shift_adjustments;

-- ---------------------------------------------------------------------------
-- 5. Closed shifts are frozen
-- ---------------------------------------------------------------------------
create or replace function public.staff_shifts_freeze_closed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only guards a shift that was ALREADY closed. Closing one (clock_out going from null
  -- to a value) writes all of these in the same statement and must be allowed.
  if old.clock_out is null then
    return new;
  end if;

  if coalesce(current_setting('calepos.shift_adjustment', true), '') = 'on' then
    return new;
  end if;

  if new.starting_cash is distinct from old.starting_cash
     or new.ending_cash is distinct from old.ending_cash
     or new.expected_cash is distinct from old.expected_cash
     or new.variance is distinct from old.variance
     or new.clock_in is distinct from old.clock_in
     or new.clock_out is distinct from old.clock_out
     or new.staff_id is distinct from old.staff_id
     or new.drawer_id is distinct from old.drawer_id then
    raise exception 'SHIFT_CLOSED: a closed shift''s cash figures cannot be edited — record an adjustment instead';
  end if;

  return new;
end $$;

drop trigger if exists staff_shifts_freeze_closed on public.staff_shifts;
create trigger staff_shifts_freeze_closed
  before update on public.staff_shifts
  for each row execute function public.staff_shifts_freeze_closed();

-- ---------------------------------------------------------------------------
-- 6. Open a shift
-- ---------------------------------------------------------------------------
-- Does the drawer-conflict check and the insert in one statement so two devices racing
-- to open the same drawer cannot both win. The unique index is the real guarantee; the
-- explicit check exists to turn a constraint violation into a message staff can act on.
-- Drop the pre-holds_drawer signature: `create or replace` with a changed argument list
-- makes a second overload rather than replacing, and PostgREST would then not know which
-- to call.
drop function if exists public.open_staff_shift(uuid, uuid, text, numeric, text, text, uuid, numeric, date, text);

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
  -- SECURITY DEFINER means RLS does not apply inside this function, so the caller's right
  -- to open THIS shift has to be checked here. Without it any signed-in staff member could
  -- open a shift in someone else's name and hang a cash shortage on them.
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

  -- Replayed push (offline retry, or a double-tap) — hand back the shift already opened.
  if p_client_id is not null then
    select * into v_existing from public.staff_shifts where client_id = p_client_id limit 1;
    if found then
      return v_existing;
    end if;
  end if;

  -- Same person already open on this drawer: resume, do not open a second shift and do
  -- not ask for another change fund. This is the accidental-logout case.
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
      raise exception
        'SHIFT_DRAWER_BUSY: drawer % still has an open shift for another cashier — they must cash out first', v_drawer;
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

-- ---------------------------------------------------------------------------
-- 7. Close a shift
-- ---------------------------------------------------------------------------
-- Expected cash is derived server-side from rows attributed to the shift, never sent by
-- the client — a client-supplied "expected" is a number the person being held to account
-- got to choose.
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

  -- SECURITY DEFINER bypasses RLS, so re-impose the branch boundary here. Within a branch
  -- anyone signed in may close a shift, because the terminal doing it is the next cashier's
  -- and the supervisor authorising the handover proves themselves by PIN in the UI, not by
  -- taking over the session — the same arrangement as supervisor-approved voids. `closed_by`
  -- records who actually did it, which is what an audit needs.
  if v_shift.branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'SHIFT_NOT_ALLOWED: that shift belongs to another branch';
  end if;

  -- Already closed: idempotent, so a retried offline push does not double-count.
  if v_shift.clock_out is not null then
    return v_shift;
  end if;

  -- A floor shift (supervisor, no drawer) just ends; there is nothing to count.
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
      closed_by = coalesce(p_closed_by, staff_id)
  where id = p_shift_id
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Correct a closed shift (supervisor+ only, always logged)
-- ---------------------------------------------------------------------------
create or replace function public.adjust_shift_cash(
  p_shift_id uuid,
  p_field text,
  p_new_value numeric,
  p_reason text,
  p_approved_by uuid default null
)
returns public.staff_shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.staff_shifts%rowtype;
  v_old numeric(12,2);
  v_expected numeric(12,2);
  v_ending numeric(12,2);
  v_actor uuid := public.current_staff_id();
  v_row public.staff_shifts%rowtype;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'SHIFT_NOT_ALLOWED: only a supervisor or manager can adjust a shift';
  end if;

  if p_field not in ('starting_cash', 'ending_cash') then
    raise exception 'SHIFT_BAD_FIELD: % cannot be adjusted', p_field;
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'SHIFT_REASON_REQUIRED: a written reason is required for an adjustment';
  end if;

  if p_new_value is null or p_new_value < 0 then
    raise exception 'SHIFT_BAD_AMOUNT: the corrected amount must be zero or more';
  end if;

  select * into v_shift from public.staff_shifts where id = p_shift_id;
  if not found then
    raise exception 'SHIFT_NOT_FOUND: no shift with id %', p_shift_id;
  end if;

  if not (v_shift.branch_id = public.current_staff_branch() or public.is_manager()) then
    raise exception 'SHIFT_NOT_ALLOWED: that shift belongs to another branch';
  end if;

  v_old := case when p_field = 'starting_cash' then v_shift.starting_cash else v_shift.ending_cash end;

  insert into public.shift_adjustments (
    shift_id, branch_id, field, old_value, new_value, reason, adjusted_by, approved_by
  ) values (
    p_shift_id, v_shift.branch_id, p_field, v_old, round(p_new_value, 2),
    trim(p_reason), v_actor, p_approved_by
  );

  -- Recompute the derived figures from whichever of the two counts just changed. The
  -- component totals (sales/refunds/paid-out/pickups) are untouched — an adjustment
  -- corrects a COUNT, never the sales record behind it.
  if p_field = 'starting_cash' then
    v_expected := round(
      round(p_new_value, 2) + coalesce(v_shift.cash_sales, 0) - coalesce(v_shift.cash_refunds, 0)
      - coalesce(v_shift.cash_paid_out, 0) - coalesce(v_shift.cash_pickups, 0), 2);
    v_ending := coalesce(v_shift.ending_cash, 0);
  else
    v_expected := coalesce(v_shift.expected_cash, 0);
    v_ending := round(p_new_value, 2);
  end if;

  perform set_config('calepos.shift_adjustment', 'on', true);

  update public.staff_shifts
  set starting_cash = case when p_field = 'starting_cash' then round(p_new_value, 2) else starting_cash end,
      ending_cash = case when p_field = 'ending_cash' then round(p_new_value, 2) else ending_cash end,
      expected_cash = case when clock_out is null then expected_cash else v_expected end,
      variance = case when clock_out is null then variance else round(v_ending - v_expected, 2) end
  where id = p_shift_id
  returning * into v_row;

  perform set_config('calepos.shift_adjustment', 'off', true);

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Live cash position of an open shift (for the cash-out screen)
-- ---------------------------------------------------------------------------
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
  -- Definer function, so scope it explicitly: a shift id alone must not expose another
  -- branch's cash position.
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
      coalesce(sum(case when status = 'completed' then coalesce(refunded_amount, 0) else total_amount end), 0) as refunds,
      count(*) filter (where status = 'completed') as sale_count
    from public.transactions
    where shift_id = p_shift_id and coalesce(payment_method, 'cash') = 'cash'
  ),
  c as (
    select
      coalesce(sum(case when kind = 'paid_out' and status = 'approved' then amount else 0 end), 0) as paid_out,
      coalesce(sum(case when kind = 'pickup' then amount else 0 end), 0) as pickups
    from public.cash_drawer_entries
    where shift_id = p_shift_id
  )
  select
    coalesce(s.starting_cash, 0),
    t.sales,
    t.refunds,
    c.paid_out,
    c.pickups,
    round(coalesce(s.starting_cash, 0) + t.sales - t.refunds - c.paid_out - c.pickups, 2),
    t.sale_count::integer
  from s, t, c;
$$;

-- ---------------------------------------------------------------------------
-- 9b. Two narrow lookups a cashier needs but RLS will not give them
-- ---------------------------------------------------------------------------
-- A cashier cannot read another cashier's shift row (section 10), which is right — but
-- they do need two facts about the drawer in front of them before they count cash into
-- it: is someone still on it, and what did the last person leave in it. These return
-- exactly those facts and nothing else, so the restriction stays meaningful. Without
-- them the clash would only surface when the queued shift-open reached the server —
-- after the cashier had counted in and started selling.
create or replace function public.drawer_holder(p_branch_id uuid, p_drawer_id text)
returns table (
  shift_id uuid,
  staff_id uuid,
  staff_name text,
  clock_in timestamptz,
  is_mine boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.staff_id, st.full_name, s.clock_in, s.staff_id = public.current_staff_id()
  from public.staff_shifts s
  left join public.staff st on st.id = s.staff_id
  where s.branch_id = p_branch_id
    and s.drawer_id = coalesce(nullif(trim(p_drawer_id), ''), 'main')
    and s.clock_out is null
    and s.holds_drawer
    and (p_branch_id = public.current_staff_branch() or public.is_manager())
  order by s.clock_in desc
  limit 1;
$$;

create or replace function public.drawer_last_count(p_branch_id uuid, p_drawer_id text)
returns table (
  shift_id uuid,
  staff_name text,
  clock_out timestamptz,
  ending_cash numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, st.full_name, s.clock_out, s.ending_cash
  from public.staff_shifts s
  left join public.staff st on st.id = s.staff_id
  where s.branch_id = p_branch_id
    and s.drawer_id = coalesce(nullif(trim(p_drawer_id), ''), 'main')
    and s.clock_out is not null
    and s.holds_drawer
    and (p_branch_id = public.current_staff_branch() or public.is_manager())
  order by s.clock_out desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- 10. RLS — a cashier sees their own shifts, supervisor+ sees the branch
-- ---------------------------------------------------------------------------
alter table public.staff_shifts enable row level security;

drop policy if exists "read staff shifts" on public.staff_shifts;
drop policy if exists "write staff shifts" on public.staff_shifts;
drop policy if exists "staff read own shifts" on public.staff_shifts;
drop policy if exists "staff open own shift" on public.staff_shifts;
drop policy if exists "staff update own open shift" on public.staff_shifts;

create policy "staff read own shifts" on public.staff_shifts
  for select to authenticated
  using (
    staff_id = public.current_staff_id()
    or public.is_manager()
    or (public.is_supervisor_or_above() and branch_id = public.current_staff_branch())
  );

create policy "staff open own shift" on public.staff_shifts
  for insert to authenticated
  with check (
    (staff_id = public.current_staff_id() and branch_id = public.current_staff_branch())
    or public.is_manager()
    or (public.is_supervisor_or_above() and branch_id = public.current_staff_branch())
  );

-- A cashier may only touch a shift of their own that is still open. Everything about a
-- closed shift is frozen for them; supervisors get through this policy but still hit the
-- freeze trigger above, so their route to a correction is adjust_shift_cash().
create policy "staff update own open shift" on public.staff_shifts
  for update to authenticated
  using (
    (staff_id = public.current_staff_id() and clock_out is null)
    or public.is_manager()
    or (public.is_supervisor_or_above() and branch_id = public.current_staff_branch())
  )
  with check (
    (staff_id = public.current_staff_id())
    or public.is_manager()
    or (public.is_supervisor_or_above() and branch_id = public.current_staff_branch())
  );

-- ---------------------------------------------------------------------------
-- 11. Grants — least privilege, matching migrate_harden_grants.sql
-- ---------------------------------------------------------------------------
-- staff_shifts_freeze_closed() is deliberately NOT revoked. Postgres checks EXECUTE on a
-- trigger function at CREATE TRIGGER time, and revoking it here has bitten people whose
-- updates then failed for no visible reason. It takes no arguments and does nothing
-- useful when called directly, so leaving the default grant costs nothing.

revoke execute on function public.open_staff_shift(uuid, uuid, text, numeric, text, text, uuid, numeric, date, text, boolean) from public, anon;
grant execute on function public.open_staff_shift(uuid, uuid, text, numeric, text, text, uuid, numeric, date, text, boolean) to authenticated;

revoke execute on function public.close_staff_shift(uuid, numeric, text, uuid) from public, anon;
grant execute on function public.close_staff_shift(uuid, numeric, text, uuid) to authenticated;

revoke execute on function public.adjust_shift_cash(uuid, text, numeric, text, uuid) from public, anon;
grant execute on function public.adjust_shift_cash(uuid, text, numeric, text, uuid) to authenticated;

revoke execute on function public.shift_cash_summary(uuid) from public, anon;
grant execute on function public.shift_cash_summary(uuid) to authenticated;

revoke execute on function public.drawer_holder(uuid, text) from public, anon;
grant execute on function public.drawer_holder(uuid, text) to authenticated;

revoke execute on function public.drawer_last_count(uuid, text) from public, anon;
grant execute on function public.drawer_last_count(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 12. Realtime (optional — matches migrate_enable_realtime.sql style)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.staff_shifts;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
