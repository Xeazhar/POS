-- Wipe test/operational data for a clean testing slate EXCEPT branches, users, and the
-- product catalog / inventory.
-- Kept: branches, roles (lookup table staff.role depends on), staff, auth.users,
--   products, catalog_products, categories (network catalog), branch_inventory
--   (each branch's current on-hand counts).
-- Deleted: every sale, every shift/drawer/day-end record, every promo/import row,
-- presence/device rows, pin lockout rows, and the stock_movements log — network-wide,
-- no date filter. This is broader than debug_reset_all_transactions.sql (which only
-- touched sales) and debug_reset_todays_transactions.sql (today's sales only), but
-- narrower than a full wipe: catalog and inventory survive so a branch doesn't need
-- re-importing/restocking after running this.
--
-- Run the PREVIEW block first. This is NOT reversible once committed.
--
-- Deleting promo_events / import_batches cascades away promo_rules+promo_rule_products /
-- import_batch_items respectively — no need to touch those child tables separately.
-- Nothing here needs FK-ordering against products/catalog_products/branch_inventory since
-- none of those are deleted — every delete below only removes rows that reference them,
-- never the referenced rows themselves.

-- ============================================================================
-- 1. PREVIEW — read-only, run this first
-- ============================================================================
-- Rows that WILL be deleted:
select 'transactions' as table_name, count(*) from transactions
union all select 'sale_events', count(*) from sale_events
union all select 'audit_events', count(*) from audit_events
union all select 'refund_requests', count(*) from refund_requests
union all select 'stock_movements', count(*) from stock_movements
union all select 'promo_events', count(*) from promo_events
union all select 'import_batches', count(*) from import_batches
union all select 'day_ends', count(*) from day_ends
union all select 'staff_shifts', count(*) from staff_shifts
union all select 'branch_presence', count(*) from branch_presence
union all select 'branch_devices', count(*) from branch_devices
union all select 'pin_login_attempts', count(*) from pin_login_attempts
order by 1;

-- Rows that will be KEPT, shown for reference only:
select 'products (kept)' as table_name, count(*) from products
union all select 'catalog_products (kept)', count(*) from catalog_products
union all select 'branch_inventory (kept)', count(*) from branch_inventory
order by 1;

-- ============================================================================
-- 2. DELETE — irreversible. Only run after checking the preview counts above.
-- ============================================================================
begin;

do $$
declare
  r record;
begin
  -- Bypass the BIR immutability triggers for this maintenance wipe only.
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

  -- Sales + audit trail
  delete from sale_refund_lines;
  delete from sale_events;
  delete from audit_events;
  -- refund_requests.transaction_id has no cascade (deliberately — it's not meant to
  -- disappear silently in production) — must go before transactions or the delete
  -- below fails with a FK violation. Guarded: pre-migrate_refund_requests.sql DBs
  -- don't have this table yet.
  do $inner$ begin
    delete from refund_requests;
  exception when undefined_table then null;
  end $inner$;
  delete from transaction_items;
  delete from transactions;

  -- Promos (promo_events cascades promo_rules + promo_rule_products)
  delete from promo_events;

  -- Inventory imports (import_batches cascades import_batch_items)
  delete from import_batches;

  -- Stock movement LOG only — branch_inventory.quantity_on_hand (the actual on-hand
  -- counts) is deliberately left alone, see file header.
  delete from stock_movements;

  -- Shifts / drawer / day-end (shift_adjustments cascades from staff_shifts, deleted
  -- explicitly too for clarity)
  delete from shift_adjustments;
  do $inner$ begin
    delete from cash_drawer_entries;
  exception when undefined_table then null;
  end $inner$;
  do $inner$ begin
    delete from petty_cash;
  exception when undefined_table then null;
  end $inner$;
  delete from staff_shifts;
  delete from day_ends;

  -- Devices / presence / login security
  delete from branch_presence;
  delete from branch_devices;
  delete from pin_login_attempts;

  -- products / catalog_products / categories / branch_inventory: deliberately NOT
  -- touched — see file header.

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
-- 3. OPTIONAL — company_profile (TIN / business registration info) is config, not
-- test data — NOT wiped above on purpose. Uncomment if you want it gone too.
-- ============================================================================
-- delete from company_profile;
