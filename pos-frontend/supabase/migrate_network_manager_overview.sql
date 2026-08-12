-- Network manager Overview aggregates — one RPC instead of N× branchSummary + N× cash impact.
-- Requires migrate_schema_cleanup_v1.sql (cash_drawer_entries only; is_manager helpers).
-- Safe to re-run.

create or replace function public.manager_overview_metrics(p_days integer default 1)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days integer := greatest(1, coalesce(p_days, 1));
  v_start timestamptz;
  v_branches jsonb := '{}'::jsonb;
  v_cash_by jsonb := '{}'::jsonb;
  v_cash_total jsonb;
  r record;
  v_branch_id uuid;
  v_open integer;
  v_today date;
  v_gross numeric;
  v_net numeric;
  v_disc numeric;
  v_ref numeric;
  v_void numeric;
  v_orders integer;
  v_revenue numeric;
  v_low integer;
  v_menu_on integer;
  v_menu_off integer;
  v_cash_sales numeric;
  v_card_sales numeric;
  v_ewallet_sales numeric;
  v_cash_refunds numeric;
  v_change_fund numeric;
  v_pickup numeric;
  v_paid_out numeric;
begin
  if not public.is_manager() then
    raise exception 'Managers only';
  end if;

  v_start := date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila'
             - make_interval(days => v_days - 1);

  for r in
    select b.id, b.branch_type, coalesce(b.day_open_hour, 7)::integer as open_hour
    from branches b
    where b.is_active is distinct from false
  loop
    v_branch_id := r.id;
    v_open := r.open_hour;
    -- Business "today" for this branch (Manila wall clock minus open-hour offset).
    v_today := ((now() at time zone 'Asia/Manila') - make_interval(hours => v_open))::date;

    select
      coalesce(sum(case when t.status = 'completed'
        then t.total_amount + coalesce(t.discount_amount, 0) else 0 end), 0),
      coalesce(sum(case when t.status = 'completed'
        then t.total_amount - coalesce(t.refunded_amount, 0) else 0 end), 0),
      coalesce(sum(case when t.status = 'completed'
        then coalesce(t.discount_amount, 0) else 0 end), 0),
      coalesce(sum(case when t.status = 'completed'
        then coalesce(t.refunded_amount, 0) else 0 end), 0),
      coalesce(sum(case when t.status = 'voided' then t.total_amount else 0 end), 0),
      coalesce(sum(case when t.status = 'completed' then t.total_amount else 0 end), 0),
      count(*) filter (where t.status = 'completed')
    into v_gross, v_net, v_disc, v_ref, v_void, v_revenue, v_orders
    from transactions t
    where t.branch_id = v_branch_id
      and t.created_at >= v_start;

    v_low := 0;
    v_menu_on := 0;
    v_menu_off := 0;
    if r.branch_type = 'restaurant' then
      select
        count(*) filter (where coalesce(p.available_today, true)),
        count(*) filter (where p.available_today = false)
      into v_menu_on, v_menu_off
      from products p
      where p.branch_id = v_branch_id and p.is_active;
    else
      select count(*) into v_low
      from branch_inventory bi
      join products p on p.id = bi.product_id
      where bi.branch_id = v_branch_id
        and p.is_active
        and bi.quantity_on_hand <= coalesce(p.low_stock_threshold, 5);
    end if;

    v_branches := v_branches || jsonb_build_object(
      v_branch_id::text,
      jsonb_build_object(
        'revenue', round(v_revenue, 2),
        'orders', v_orders,
        'lowStock', v_low,
        'menuOn', v_menu_on,
        'menuOff', v_menu_off,
        'branchType', case when r.branch_type = 'restaurant' then 'restaurant' else 'retail' end,
        'grossSales', round(v_gross, 2),
        'netSales', round(v_net, 2),
        'discounts', round(v_disc, 2),
        'refunds', round(v_ref, 2),
        'voidedSales', round(v_void, 2)
      )
    );

    -- Cash impact for THIS business day only (drawer counted once per day).
    select
      coalesce(sum(case
        when t.status = 'completed'
         and coalesce(lower(t.payment_method), 'cash') not in ('card', 'ewallet')
        then greatest(0, t.total_amount - coalesce(t.refunded_amount, 0)) else 0 end), 0),
      coalesce(sum(case
        when t.status = 'completed' and lower(t.payment_method) = 'card'
        then greatest(0, t.total_amount - coalesce(t.refunded_amount, 0)) else 0 end), 0),
      coalesce(sum(case
        when t.status = 'completed' and lower(t.payment_method) = 'ewallet'
        then greatest(0, t.total_amount - coalesce(t.refunded_amount, 0)) else 0 end), 0),
      coalesce(sum(case
        when t.status = 'completed'
         and coalesce(lower(t.payment_method), 'cash') not in ('card', 'ewallet')
        then coalesce(t.refunded_amount, 0) else 0 end), 0)
    into v_cash_sales, v_card_sales, v_ewallet_sales, v_cash_refunds
    from transactions t
    where t.branch_id = v_branch_id
      and ((t.created_at at time zone 'Asia/Manila') - make_interval(hours => v_open))::date = v_today;

    select coalesce(sum(ss.starting_cash), 0) into v_change_fund
    from staff_shifts ss
    where ss.branch_id = v_branch_id
      and ss.holds_drawer is distinct from false
      and ss.business_date = v_today;

    select
      coalesce(sum(case when cde.kind = 'change_fund' then cde.amount else 0 end), 0)
        + v_change_fund,
      coalesce(sum(case when cde.kind = 'pickup' then cde.amount else 0 end), 0),
      coalesce(sum(case when cde.kind = 'paid_out' and cde.status = 'fulfilled' then cde.amount else 0 end), 0)
    into v_change_fund, v_pickup, v_paid_out
    from cash_drawer_entries cde
    where cde.branch_id = v_branch_id
      and cde.business_date = v_today;

    v_cash_by := v_cash_by || jsonb_build_object(
      v_branch_id::text,
      jsonb_build_object(
        'cashSales', round(v_cash_sales, 2),
        'cardSales', round(v_card_sales, 2),
        'ewalletSales', round(v_ewallet_sales, 2),
        'cashRefunds', round(v_cash_refunds, 2),
        'changeFund', round(v_change_fund, 2),
        'pickup', round(v_pickup, 2),
        'paidOut', round(v_paid_out, 2),
        'expectedCash', round(v_change_fund + v_cash_sales - v_paid_out - v_pickup, 2)
      )
    );
  end loop;

  select jsonb_build_object(
    'cashSales', coalesce(sum((value->>'cashSales')::numeric), 0),
    'cardSales', coalesce(sum((value->>'cardSales')::numeric), 0),
    'ewalletSales', coalesce(sum((value->>'ewalletSales')::numeric), 0),
    'cashRefunds', coalesce(sum((value->>'cashRefunds')::numeric), 0),
    'changeFund', coalesce(sum((value->>'changeFund')::numeric), 0),
    'pickup', coalesce(sum((value->>'pickup')::numeric), 0),
    'paidOut', coalesce(sum((value->>'paidOut')::numeric), 0),
    'expectedCash', coalesce(sum((value->>'expectedCash')::numeric), 0)
  )
  into v_cash_total
  from jsonb_each(v_cash_by);

  return jsonb_build_object(
    'branches', v_branches,
    'cashByBranch', v_cash_by,
    'cashImpact', coalesce(v_cash_total, jsonb_build_object(
      'cashSales', 0, 'cardSales', 0, 'ewalletSales', 0, 'cashRefunds', 0,
      'changeFund', 0, 'pickup', 0, 'paidOut', 0, 'expectedCash', 0
    ))
  );
end;
$$;

grant execute on function public.manager_overview_metrics(integer) to authenticated;

comment on function public.manager_overview_metrics(integer) is
  'Manager Overview: per-branch sales KPIs for the last N local days + today cash impact in one round trip.';
