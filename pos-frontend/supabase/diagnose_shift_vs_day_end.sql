-- Diagnose: cashier "End shift" total vs supervisor "Day end" total.
--
-- READ-ONLY. Writes nothing. Run the whole thing in the Supabase SQL editor and paste the
-- output. Anchors itself on the MOST RECENTLY OPENED shift, so there is nothing to edit.
--
-- What each section tells you:
--   0  whether migrate_shift_cash_void_fix.sql actually applied
--   1  the shift the cashier is on
--   2  what shift_cash_summary() returns — the exact number the cashier's screen shows.
--      MAY COME BACK EMPTY: the function checks current_staff_id(), which is null in the
--      SQL editor. If it is empty that is an artifact of running it here, not a bug —
--      section 2b recomputes the same thing without the permission check.
--   3  every recent transaction and which shift it is attributed to. A `** NULL **` or
--      `OTHER SHIFT` line is a sale the cashier's total cannot see but the supervisor's can.
--   4  same for cash drawer entries (petty cash / pickups).
--   5  the supervisor-side totals, computed the way the Day End screen computes them.
--
-- The mismatch is whatever differs between 2b and 5.

with sh as (
  select * from public.staff_shifts order by clock_in desc limit 1
),
tx as (
  select t.*
  from public.transactions t, sh
  where t.branch_id = sh.branch_id
    and t.created_at >= sh.clock_in - interval '12 hours'
),
cde as (
  select c.*
  from public.cash_drawer_entries c, sh
  where c.branch_id = sh.branch_id
    and c.business_date = sh.business_date
),
mine as (  -- exactly what shift_cash_summary() scopes to: this shift_id, cash only
  select
    coalesce(sum(case when status = 'completed' then total_amount else 0 end), 0) as sales,
    coalesce(sum(case when status = 'completed' then coalesce(refunded_amount, 0) else 0 end), 0) as refunds,
    count(*) filter (where status = 'completed') as sale_count
  from tx, sh
  where tx.shift_id = sh.id and coalesce(tx.payment_method, 'cash') = 'cash'
),
mine_c as (
  select
    coalesce(sum(case when kind = 'paid_out' and status = 'fulfilled' then amount else 0 end), 0) as paid_out,
    coalesce(sum(case when kind = 'pickup' then amount else 0 end), 0) as pickups
  from cde, sh
  where cde.shift_id = sh.id
)
select detail from (

  select 0 as ord, 0 as sub,
    '=== 0. VOID FIX APPLIED? === ' ||
    case
      when pg_get_functiondef('public.shift_cash_summary(uuid)'::regprocedure)
           like '%coalesce(refunded_amount, 0) else 0 end%'
        then 'YES - void fix is live'
      else 'NO  - migrate_shift_cash_void_fix.sql has NOT been applied to this database'
    end as detail

  union all select 1, 0, '=== 1. SHIFT (most recently opened) ==='
  union all
  select 1, 1,
    'shift_id=' || id
    || ' | staff_id=' || coalesce(staff_id::text, '-')
    || ' | drawer=' || coalesce(drawer_id, '-')
    || ' | business_date=' || coalesce(business_date::text, 'NULL')
    || ' | clock_in=' || to_char(clock_in, 'YYYY-MM-DD HH24:MI')
    || ' | starting_cash=' || coalesce(starting_cash::text, 'NULL')
    || ' | holds_drawer=' || holds_drawer::text
    || ' | open=' || (clock_out is null)::text
  from sh

  union all select 2, 0, '=== 2. shift_cash_summary() — what the cashier screen shows ==='
  union all
  select 2, 1,
    'starting=' || starting_cash || ' | sales=' || cash_sales || ' | refunds=' || cash_refunds
    || ' | paid_out=' || cash_paid_out || ' | pickups=' || cash_pickups
    || ' | EXPECTED=' || expected_cash || ' | sale_count=' || sale_count
  from public.shift_cash_summary((select id from sh))

  union all select 3, 0, '=== 2b. same maths, no permission check (use if 2 was empty) ==='
  union all
  select 3, 1,
    'starting=' || coalesce((select starting_cash from sh), 0)
    || ' | sales=' || m.sales || ' | refunds=' || m.refunds
    || ' | paid_out=' || c.paid_out || ' | pickups=' || c.pickups
    || ' | EXPECTED=' || round(coalesce((select starting_cash from sh), 0)
                              + m.sales - m.refunds - c.paid_out - c.pickups, 2)
    || ' | sale_count=' || m.sale_count
  from mine m, mine_c c

  union all select 4, 0, '=== 3. TRANSACTIONS (last 12h on this branch) ==='
  union all
  select 4, 1,
    'or=' || coalesce(or_number, '-')
    || ' | ' || to_char(created_at, 'MM-DD HH24:MI')
    || ' | ' || status
    || ' | pay=' || coalesce(payment_method, 'cash')
    || ' | total=' || total_amount
    || ' | refunded=' || coalesce(refunded_amount, 0)
    || ' | shift_id=' || coalesce(shift_id::text, '** NULL **')
    || case
         when shift_id is null then '   <<< NOT ON ANY SHIFT - cashier total cannot see it'
         when shift_id <> (select id from sh) then '   <<< DIFFERENT SHIFT'
         else ''
       end
  from tx

  union all select 5, 0, '=== 4. CASH DRAWER ENTRIES (this business date) ==='
  union all
  select 5, 1,
    coalesce(kind, '-') || ' | status=' || coalesce(status, '-')
    || ' | amount=' || amount
    || ' | reason=' || left(coalesce(reason, ''), 40)
    || ' | shift_id=' || coalesce(shift_id::text, '** NULL **')
    || case
         when shift_id is null then '   <<< NOT ON ANY SHIFT - cashier total cannot see it'
         when shift_id <> (select id from sh) then '   <<< DIFFERENT SHIFT'
         else ''
       end
  from cde

  union all select 6, 0, '=== 5. SUPERVISOR-SIDE TOTALS (how Day End computes them) ==='
  union all
  select 6, 1,
    'float(all drawer shifts today)='
      || (select coalesce(sum(ss.starting_cash), 0) from public.staff_shifts ss, sh
          where ss.branch_id = sh.branch_id and ss.business_date = sh.business_date
            and ss.holds_drawer)
    || ' | cash sales(net, ALL txns regardless of shift)='
      || (select coalesce(sum(total_amount - coalesce(refunded_amount, 0)), 0) from tx
          where status = 'completed' and coalesce(payment_method, 'cash') = 'cash')
    || ' | paid_out(fulfilled, ALL)='
      || (select coalesce(sum(amount), 0) from cde where kind = 'paid_out' and status = 'fulfilled')
    || ' | pickups(ALL)='
      || (select coalesce(sum(amount), 0) from cde where kind = 'pickup')

) sections
order by ord, sub;
