-- Petty cash: three distinct states instead of two.
--
--   pending    someone asked. No money has moved.
--   approved   a supervisor+ authorised it. Still no money has moved.
--   fulfilled  cash was physically handed over. THIS is the disbursement.
--
-- WHY the split: "approved" was being treated as "paid", so the expected-drawer figure
-- deducted cash that might still be sitting in the till. A request approved at 2pm and
-- handed over at 5pm made the drawer look short for three hours, and a request approved
-- but never handed over made it look short forever.
--
-- PREREQUISITES — apply these first, in this order:
--   migrate_cash_accountability_controls.sql   (cash_drawer_entries.kind/status/approved_by)
--     or migrate_rename_petty_cash_to_cash_drawer_entries.sql — either creates those columns
--   migrate_shift_cash_accountability.sql      (transactions.shift_id, and the original
--     close_staff_shift / shift_cash_summary that section 5 below redefines)
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 0) Fail early and clearly rather than half-applying
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.cash_drawer_entries') is null then
    raise exception 'cash_drawer_entries is missing — apply migrate_cash_accountability_controls.sql first';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'transactions' and column_name = 'shift_id'
  ) then
    raise exception 'transactions.shift_id is missing — apply migrate_shift_cash_accountability.sql first';
  end if;
end $$;

-- confirmed_by / confirmed_at already exist from the earlier migration; assert it here so
-- this file is self-contained if run against an older environment.
alter table public.cash_drawer_entries add column if not exists confirmed_by uuid references public.staff(id) on delete set null;
alter table public.cash_drawer_entries add column if not exists confirmed_at timestamptz;

-- ---------------------------------------------------------------------------
-- 1) Allow the new status
-- ---------------------------------------------------------------------------
alter table public.cash_drawer_entries drop constraint if exists cash_drawer_entries_status_check;
alter table public.cash_drawer_entries drop constraint if exists petty_cash_status_check;

alter table public.cash_drawer_entries
  add constraint cash_drawer_entries_status_check
  check (status in ('pending', 'approved', 'rejected', 'recorded', 'fulfilled'));

-- ---------------------------------------------------------------------------
-- 2) Backfill — MUST run before the fulfilment constraint is added
-- ---------------------------------------------------------------------------
-- Ordering matters: `not valid` only skips the one-off scan of existing rows, it does NOT
-- exempt an UPDATE. Adding the constraint first makes this very backfill illegal.
alter table public.cash_drawer_entries drop constraint if exists cash_drawer_entries_fulfil_needs_approval;

-- Every paid-out already marked approved BEFORE this migration was, in practice, cash that
-- had already been handed over — that is what "approved" meant under the old two-state
-- model. Re-labelling them 'fulfilled' keeps historical day-end figures identical; leaving
-- them 'approved' would retroactively add that cash back into every past expected drawer.
update public.cash_drawer_entries
set status = 'fulfilled',
    confirmed_by = coalesce(confirmed_by, approved_by, staff_id),
    confirmed_at = coalesce(confirmed_at, approved_at, created_at)
where kind = 'paid_out'
  and status = 'approved';

-- Rows that predate approval tracking keep a null approver. Do NOT fill it in: the only
-- candidate is the requester, and writing that would record a cashier approving their own
-- petty cash — a sign-off that never happened, in an audit trail. A null here is honest:
-- under the old two-state model there was no separate approval step to record.

-- ---------------------------------------------------------------------------
-- 3) Fulfilment can never exist without a prior approval
-- ---------------------------------------------------------------------------
-- This is the whole point of the task and it is enforced in the database, not only in the
-- UI: a client that skipped the approve step (or a direct table write) must not be able to
-- mark cash as handed over.
alter table public.cash_drawer_entries
  add constraint cash_drawer_entries_fulfil_needs_approval
  check (
    status <> 'fulfilled'
    or (approved_by is not null and approved_at is not null)
  )
  not valid;
-- Left permanently NOT VALID, and deliberately never VALIDATEd — same pattern as
-- transactions_vat_breakdown_sane_check. It is fully enforced on every new insert and
-- update; the exemption applies only to the historical rows above, which are immutable
-- day-end history and must not be rewritten to satisfy a rule that postdates them.

-- ---------------------------------------------------------------------------
-- 4) Index for the two queues the UI reads constantly
-- ---------------------------------------------------------------------------
drop index if exists idx_cash_drawer_entries_pending;
create index if not exists idx_cash_drawer_entries_open
  on public.cash_drawer_entries (branch_id, status, created_at desc)
  where kind = 'paid_out' and status in ('pending', 'approved');

-- ---------------------------------------------------------------------------
-- 5) Shift cash maths must follow the new meaning of the states
-- ---------------------------------------------------------------------------
-- close_staff_shift() and shift_cash_summary() both deducted `status = 'approved'` from
-- the expected drawer. Under the three-state model that is exactly backwards: 'approved'
-- money is still IN the till and 'fulfilled' money is the money that left it. Left
-- unchanged, every cash-out after this migration would report a false variance.
--
-- Both are redefined verbatim from migrate_shift_cash_accountability.sql with only that
-- predicate changed.

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

  -- Already closed: idempotent, so a retried offline push does not double-count.
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
    -- 'fulfilled', not 'approved' — see the note at the top of this section.
    coalesce(sum(case when c.kind = 'paid_out' and c.status = 'fulfilled' then c.amount else 0 end), 0),
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
      coalesce(sum(case when status = 'completed' then coalesce(refunded_amount, 0) else total_amount end), 0) as refunds,
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

-- Verify
--   select status, count(*) from public.cash_drawer_entries where kind = 'paid_out' group by status;
--   select * from public.shift_cash_summary('<an open shift id>');
