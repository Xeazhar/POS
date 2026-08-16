-- Clear ALL sales + shift/drawer/day-end data for a fresh testing slate.
-- Union of debug_reset_all_transactions.sql (sales side) + the shift-related deletes
-- from debug_wipe_all_except_branches_and_users.sql (drawer side) — nothing more.
--
-- Scope: transactions, transaction_items (cascades), sale_refund_lines (cascades),
-- sale_events, refund_requests, cash_movements, shift_adjustments (cascades from
-- staff_shifts, deleted explicitly first anyway since cash_movements.shift_id is
-- ON DELETE RESTRICT and must be cleared before staff_shifts can go), cash_drawer_entries
-- (or legacy petty_cash), staff_shifts, day_ends.
--
-- NOT touched (on purpose):
--   * branch_inventory.quantity_on_hand — a running counter, not derived from
--     stock_movements at read time. Clearing transactions does NOT put stock back.
--   * stock_movements — left in place; it's the log explaining current on-hand counts.
--   * promo_events / import_batches / branch_presence / branch_devices /
--     pin_login_attempts / till_action_requests — untouched, out of scope for
--     "transactions and shifts".
--   * products / catalog_products / branches / staff — nothing here touches setup data.
--
-- Run the PREVIEW block first. This is NOT reversible once committed.

-- ============================================================================
-- 1. PREVIEW — read-only, run this first
-- ============================================================================
-- To scope to one branch instead of every branch, uncomment the `where branch_id = '...'`
-- lines below and fill in that branch's id (keep in sync with the DELETE block's
-- v_branch_id in section 2).
select
  (select count(*) from transactions
    -- where branch_id = '00000000-0000-0000-0000-000000000000'
  ) as transactions_to_delete,
  (select count(*) from sale_events
    -- where branch_id = '00000000-0000-0000-0000-000000000000'
  ) as sale_events_to_delete,
  (select count(*) from staff_shifts
    -- where branch_id = '00000000-0000-0000-0000-000000000000'
  ) as staff_shifts_to_delete,
  (select count(*) from day_ends
    -- where branch_id = '00000000-0000-0000-0000-000000000000'
  ) as day_ends_to_delete;

-- ============================================================================
-- 2. DELETE — irreversible. Only run after checking the preview counts above.
-- ============================================================================
begin;

do $$
declare
  v_branch_id uuid := null; -- <-- keep in sync with the preview block above
  r record;
begin
  -- Bypass the BIR immutability triggers for this maintenance reset only.
  for r in
    select tgname from pg_trigger
    where tgrelid = 'public.transactions'::regclass and not tgisinternal
  loop
    execute format('alter table public.transactions disable trigger %I', r.tgname);
  end loop;
  for r in
    select tgname from pg_trigger
    where tgrelid = 'public.transaction_items'::regclass and not tgisinternal
  loop
    execute format('alter table public.transaction_items disable trigger %I', r.tgname);
  end loop;

  -- --- Sales side -----------------------------------------------------------
  -- sale_refund_lines is ON DELETE CASCADE from transactions, but sale_events is only
  -- ON DELETE SET NULL — delete it explicitly first or it survives as an orphaned row
  -- with transaction_id nulled out.
  delete from sale_events
  where (v_branch_id is null or branch_id = v_branch_id);

  -- refund_requests.transaction_id has no cascade (deliberately) — must go before
  -- transactions or the delete below fails with a FK violation. Guarded: pre-
  -- migrate_refund_requests.sql DBs don't have this table yet.
  do $inner$ begin
    delete from refund_requests
    where transaction_id in (
      select id from transactions where (v_branch_id is null or branch_id = v_branch_id)
    );
  exception when undefined_table then null;
  end $inner$;

  delete from transactions
  where (v_branch_id is null or branch_id = v_branch_id);

  -- --- Shift / drawer side ---------------------------------------------------
  -- cash_movements.shift_id is ON DELETE RESTRICT against staff_shifts — must be
  -- cleared before staff_shifts or that delete fails with a FK violation. Guarded:
  -- pre-migrate_cash_movements.sql DBs don't have this table yet.
  do $inner$ begin
    delete from cash_movements
    where (v_branch_id is null or branch_id = v_branch_id);
  exception when undefined_table then null;
  end $inner$;

  -- shift_adjustments cascades from staff_shifts already; deleted explicitly first
  -- for clarity/order, matching debug_wipe_all_except_branches_and_users.sql.
  do $inner$ begin
    delete from shift_adjustments
    where (v_branch_id is null or branch_id = v_branch_id);
  exception when undefined_table then null;
  end $inner$;

  do $inner$ begin
    delete from cash_drawer_entries
    where (v_branch_id is null or branch_id = v_branch_id);
  exception when undefined_table then null;
  end $inner$;
  do $inner$ begin
    delete from petty_cash
    where (v_branch_id is null or branch_id = v_branch_id);
  exception when undefined_table then null;
  end $inner$;

  delete from staff_shifts
  where (v_branch_id is null or branch_id = v_branch_id);

  delete from day_ends
  where (v_branch_id is null or branch_id = v_branch_id);

  -- Re-enable the guards.
  for r in
    select tgname from pg_trigger
    where tgrelid = 'public.transactions'::regclass and not tgisinternal
  loop
    execute format('alter table public.transactions enable trigger %I', r.tgname);
  end loop;
  for r in
    select tgname from pg_trigger
    where tgrelid = 'public.transaction_items'::regclass and not tgisinternal
  loop
    execute format('alter table public.transaction_items enable trigger %I', r.tgname);
  end loop;
end $$;

commit;

-- ============================================================================
-- 3. OPTIONAL — also wipe all stock_movements log rows.
-- Only do this if you also intend to hand-fix branch_inventory.quantity_on_hand
-- afterward; otherwise on-hand counts keep every past stock change with nothing left
-- explaining them.
-- ============================================================================
-- begin;
-- delete from stock_movements
-- where movement_type in ('sale', 'restock')
--   and reference is not null; -- leave manual adjustments (movement_type='adjustment') alone
-- commit;
