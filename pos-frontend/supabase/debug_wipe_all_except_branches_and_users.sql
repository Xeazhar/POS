-- Wipe test/operational data for a clean testing slate EXCEPT branches and users.
-- Kept: branches, roles (lookup table staff.role depends on), staff, auth.users.
-- Deleted: every sale, every shift/drawer/day-end record, every promo/import row,
-- presence/device rows, pin lockout rows, the stock_movements log, announcements,
-- and the full product catalog (products, catalog_products, categories,
-- branch_inventory) — network-wide, no date filter. This is broader than
-- debug_reset_all_transactions.sql (which only touched sales) and
-- debug_reset_todays_transactions.sql (today's sales only), and unlike its previous
-- version, catalog/inventory no longer survive — every branch needs
-- re-importing/restocking after running this.
--
-- Run the PREVIEW block first. This is NOT reversible once committed.
--
-- Deleting promo_events / import_batches cascades away promo_rules+promo_rule_products /
-- import_batch_items respectively — no need to touch those child tables separately.
-- branch_inventory, products, catalog_products, categories are deleted in that order
-- (each is FK-referenced by the one before it) after every other table that
-- references products (transaction_items, stock_movements, sale_refund_lines,
-- promo_rule_products, import_batch_items) has already been cleared above.

-- ============================================================================
-- 1. PREVIEW — read-only, run this first
-- ============================================================================
-- Rows that WILL be deleted:
select 'transactions' as table_name, count(*) from transactions
union all select 'sale_events', count(*) from sale_events
union all select 'audit_events', count(*) from audit_events
union all select 'refund_requests', count(*) from refund_requests
union all select 'stock_movements', count(*) from stock_movements
union all select 'cash_movements', count(*) from cash_movements
union all select 'promo_events', count(*) from promo_events
union all select 'import_batches', count(*) from import_batches
union all select 'day_ends', count(*) from day_ends
union all select 'staff_shifts', count(*) from staff_shifts
union all select 'branch_presence', count(*) from branch_presence
union all select 'branch_devices', count(*) from branch_devices
union all select 'pin_login_attempts', count(*) from pin_login_attempts
union all select 'announcements', count(*) from announcements
union all select 'branch_inventory', count(*) from branch_inventory
union all select 'products', count(*) from products
union all select 'catalog_products', count(*) from catalog_products
union all select 'categories', count(*) from categories
order by 1;

-- Rows that will be KEPT, shown for reference only:
select 'branches (kept)' as table_name, count(*) from branches
union all select 'staff (kept)', count(*) from staff
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

  -- Stock movement LOG (branch_inventory itself is cleared later with the catalog).
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
  -- cash_movements.shift_id references staff_shifts(id) on delete restrict — must go
  -- before staff_shifts or the delete below fails with a FK violation.
  do $inner$ begin
    delete from cash_movements;
  exception when undefined_table then null;
  end $inner$;
  delete from staff_shifts;
  delete from day_ends;

  -- Devices / presence / login security
  delete from branch_presence;
  delete from branch_devices;
  delete from pin_login_attempts;

  -- Announcements
  do $inner$ begin
    delete from announcements;
  exception when undefined_table then null;
  end $inner$;

  -- Full product catalog: branch_inventory before products (FK), products before
  -- catalog_products (FK), catalog_products before categories (FK).
  delete from branch_inventory;
  delete from products;
  delete from catalog_products;
  delete from categories;

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
