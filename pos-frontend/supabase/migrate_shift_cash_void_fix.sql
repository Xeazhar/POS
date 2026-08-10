-- Fix: a voided cash sale wrongly subtracted its full amount from expected drawer cash.
--
-- WHY
-- ---
-- close_staff_shift() and shift_cash_summary() computed, per cash transaction:
--   sales   = total_amount WHEN status = 'completed' ELSE 0
--   refunds = refunded_amount WHEN status = 'completed' ELSE total_amount
--
-- A voided transaction (status <> 'completed') contributes 0 to `sales` (correct — it is
-- no longer a sale) but its FULL total_amount to `refunds` (wrong). Net effect on
-- expected_cash: -total_amount. The correct net effect is ZERO — whatever cash the sale
-- put in the drawer, the void takes back out, and neither side was ever counted as kept.
-- Concretely: if a shift's only transaction was a ₱500 cash sale that got voided, expected
-- cash should equal the starting float; the buggy formula reported it ₱500 short.
--
-- This is why a cashier's "Your shift so far" (End Shift) could read lower than the
-- supervisor's "Expected in drawer" on Day End by exactly the sum of that shift's voided
-- cash sales — the supervisor's client-side total already excluded voids from both sides
-- and never had this bug.
--
-- Fix: a non-completed (voided) row now contributes 0 to `refunds`, same as it already does
-- to `sales`. Partial-refund handling on still-completed sales (`refunded_amount`) is
-- unchanged.
--
-- close_staff_shift() is redefined from its true latest source,
-- migrate_day_end_request_no_shift_count.sql (applied AFTER migrate_petty_cash_fulfilment.sql
-- despite the misleading filenames — that file's version is the one actually live: nullable
-- p_ending_cash, no SHIFT_COUNT_REQUIRED check, conditional-null ending_cash/expected_cash/
-- variance). Only two changes on top of that base:
--   1. The `refunds` CASE's ELSE branch: total_amount -> 0 (the fix this file is for).
--   2. The paid_out predicate restored to 'fulfilled' (migrate_day_end_request_no_shift_count.sql
--      was itself authored from an older base and had regressed this back to 'approved' —
--      'approved' money is still IN the till; deducting it reports a false shortage. Every
--      other consumer in the app — DayEnd.jsx, terminalReports.js, shift_cash_summary() below —
--      already filters on 'fulfilled'; leaving this one on 'approved' silently disagreed with
--      all of them. See migrate_petty_cash_fulfilment.sql and CODEMAP.md's "Only `fulfilled`
--      is deducted" note.)
--
-- shift_cash_summary() is unaffected by the signature error (single required param) and is
-- redefined verbatim from migrate_petty_cash_fulfilment.sql with only the same refunds fix.
--
-- PREREQUISITE: migrate_day_end_request_no_shift_count.sql (current close_staff_shift shape).
--
-- Safe to re-run.

do $$
begin
  if to_regclass('public.staff_shifts') is null then
    raise exception 'staff_shifts is missing — apply migrate_shift_cash_accountability.sql first';
  end if;
end $$;

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
    -- A voided sale (status <> 'completed') nets to 0 here, not t.total_amount — see file
    -- header. Only a still-completed sale's own refunded_amount is a real drawer outflow.
    coalesce(sum(
      case when t.status = 'completed' then coalesce(t.refunded_amount, 0) else 0 end
    ), 0)
  into v_sales, v_refunds
  from public.transactions t
  where t.shift_id = p_shift_id
    and coalesce(t.payment_method, 'cash') = 'cash';

  select
    -- 'fulfilled', not 'approved' — see file header.
    coalesce(sum(case when c.kind = 'paid_out' and c.status = 'fulfilled' then c.amount else 0 end), 0),
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
      -- closed_without_supervisor intentionally NOT set here — see
      -- migrate_day_end_request_no_shift_count.sql's file header.
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
      -- See file header: a voided row nets to 0, not total_amount.
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

grant execute on function public.close_staff_shift(uuid, numeric, text, uuid) to authenticated;
grant execute on function public.shift_cash_summary(uuid) to authenticated;

notify pgrst, 'reload schema';

-- Verify — pick a shift that had a voided cash sale and confirm expected_cash no longer
-- reads short by that sale's amount:
--   select * from public.shift_cash_summary('<shift id>');
