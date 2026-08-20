-- shift_cash_summary() already folds cash_movements 'cash_in' rows (additional float
-- added mid-shift via POS -> Open Drawer -> Cash in) into expected_cash, but never
-- returned the amount itself as a column. The cashier's "Your shift so far" breakdown
-- (OwnShiftSoFar.jsx) could therefore show a total that didn't reconcile against the
-- rows it listed above it -- Expected drawer was right, but nothing on screen showed
-- where the cash_in portion came from.
-- Prerequisite: migrate_cash_movement_cash_in.sql
-- Safe to re-run.

-- RETURNS TABLE compiles to a row type Postgres won't let CREATE OR REPLACE widen --
-- "cannot change return type of existing function" -- so the old signature has to be
-- dropped first. Safe: shift_cash_summary is stable/security definer with no dependent
-- views or other functions referencing its exact column list.
drop function if exists public.shift_cash_summary(uuid);

create function public.shift_cash_summary(p_shift_id uuid)
returns table (
  starting_cash numeric,
  cash_sales numeric,
  cash_refunds numeric,
  cash_paid_out numeric,
  cash_pickups numeric,
  expected_cash numeric,
  sale_count integer,
  cash_in numeric
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
    t.sale_count::integer,
    m.cash_in
  from s, t, c, m;
$$;
