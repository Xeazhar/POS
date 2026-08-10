-- Reset TODAY's sales data for debugging the Dashboard/Overview numbers.
-- Scope: transactions, transaction_items (cascades), sale_refund_lines (cascades),
-- sale_events, and refund_requests (pending manager-approval requests, if any) — all
-- filtered to "today" by calendar date in Asia/Manila, matching
-- how mapTransaction()/Dashboard.jsx actually bucket a transaction's `.date`
-- (localDateKey(created_at) — the plain calendar day, NOT business_date/open-hour).
--
-- NOT touched (on purpose — out of scope for a sales/audit reset):
--   * branch_inventory.quantity_on_hand — a running counter, not derived from
--     stock_movements at read time. Deleting today's sales does NOT put stock back;
--     if today's sales/voids moved stock, on-hand counts will stay wherever they
--     currently sit after this runs.
--   * stock_movements — left in place for the same reason (it's the log explaining
--     today's on-hand counts; deleting it would make counts unexplainable without
--     fixing them). See the optional block at the bottom if you want it gone too.
--   * day_ends / staff_shifts / cash_drawer_entries — shift and till state, unrelated
--     to which sales rows exist.
--
-- Run the PREVIEW block first and read the counts before running the DELETE block.
-- This is NOT reversible once committed — there is no undo.

-- ============================================================================
-- 0. Set scope here. Leave branch_id NULL to reset every branch's "today".
-- ============================================================================
-- (edited inline in each block below — no session variables needed)
--   v_branch_id  uuid  := null   -- or a specific branches.id to scope to one branch

-- ============================================================================
-- 1. PREVIEW — read-only, run this first
-- ============================================================================
-- `raise notice` doesn't reliably show up in the Supabase SQL editor's results grid
-- (it's session-log level, easy to miss or filtered by client_min_messages) — a plain
-- select always returns a visible row, so use that instead.
-- To scope to one branch, uncomment the two `and branch_id = '...'` lines below and
-- fill in that branch's id (keep both in sync with each other and with the DELETE
-- block's v_branch_id in section 2).
select
  (timezone('Asia/Manila', now()))::date as business_day,
  (
    select count(*) from transactions
    where (timezone('Asia/Manila', created_at))::date = (timezone('Asia/Manila', now()))::date
      -- and branch_id = '00000000-0000-0000-0000-000000000000'
  ) as transactions_to_delete,
  (
    select count(*) from sale_events
    where (timezone('Asia/Manila', created_at))::date = (timezone('Asia/Manila', now()))::date
      -- and branch_id = '00000000-0000-0000-0000-000000000000'
  ) as sale_events_to_delete;

-- ============================================================================
-- 2. DELETE — irreversible. Only run after checking the preview counts above.
-- ============================================================================
begin;

do $$
declare
  v_branch_id uuid := null; -- <-- keep in sync with the preview block above
  v_today date := (timezone('Asia/Manila', now()))::date;
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
  -- with transaction_id nulled out, which is exactly the stale-audit-row problem this
  -- script exists to clear out.
  delete from sale_events
  where (timezone('Asia/Manila', created_at))::date = v_today
    and (v_branch_id is null or branch_id = v_branch_id);

  -- refund_requests.transaction_id has no cascade (deliberately) — must go before
  -- transactions or the delete below fails with a FK violation. Guarded: pre-
  -- migrate_refund_requests.sql DBs don't have this table yet.
  do $inner$ begin
    delete from refund_requests
    where transaction_id in (
      select id from transactions
      where (timezone('Asia/Manila', created_at))::date = v_today
        and (v_branch_id is null or branch_id = v_branch_id)
    );
  exception when undefined_table then null;
  end $inner$;

  delete from transactions
  where (timezone('Asia/Manila', created_at))::date = v_today
    and (v_branch_id is null or branch_id = v_branch_id);

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
-- 3. OPTIONAL — also wipe today's stock_movements log.
-- Only do this if you also intend to hand-fix branch_inventory.quantity_on_hand
-- afterward; otherwise the on-hand counts keep today's stock changes with nothing
-- left explaining them. `reference` is a free-text column (not a real FK), matched
-- against the transaction ids deleted above — since those rows are already gone,
-- this instead matches by the same Asia/Manila calendar day on stock_movements'
-- own created_at.
-- ============================================================================
-- begin;
-- delete from stock_movements
-- where (timezone('Asia/Manila', created_at))::date = (timezone('Asia/Manila', now()))::date
--   and movement_type in ('sale', 'restock')
--   and reference is not null; -- leave manual adjustments (movement_type='adjustment') alone
-- commit;
