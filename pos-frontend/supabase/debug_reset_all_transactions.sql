-- Clear ALL sales data for a fresh testing slate — every transaction, not just today's.
-- Same scope as debug_reset_todays_transactions.sql minus the date filter:
-- transactions, transaction_items (cascades), sale_refund_lines (cascades), sale_events,
-- refund_requests (pending manager-approval requests, if any).
--
-- NOT touched (on purpose):
--   * branch_inventory.quantity_on_hand — a running counter, not derived from
--     stock_movements at read time. Clearing transactions does NOT put stock back.
--   * stock_movements — left in place; it's the log explaining current on-hand counts.
--     See the optional block at the bottom if you want it gone too.
--   * day_ends / staff_shifts / cash_drawer_entries — shift and till state.
--   * products / catalog_products / branches / staff — nothing here touches setup data.
--
-- Run the PREVIEW block first. This is NOT reversible once committed.

-- ============================================================================
-- 1. PREVIEW — read-only, run this first
-- ============================================================================
-- To scope to one branch instead of every branch, uncomment the two
-- `and branch_id = '...'` lines below and fill in that branch's id (keep in sync with
-- the DELETE block's v_branch_id in section 2).
select
  (select count(*) from transactions
    -- where branch_id = '00000000-0000-0000-0000-000000000000'
  ) as transactions_to_delete,
  (select count(*) from sale_events
    -- where branch_id = '00000000-0000-0000-0000-000000000000'
  ) as sale_events_to_delete;

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
