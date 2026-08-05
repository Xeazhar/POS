-- DANGER: wipes ALL branch products + network catalog for a clean re-import.
-- Also clears sales/inventory rows that reference those products.
-- BIR triggers block DELETE on transactions / transaction_items — disable them for this wipe only.
-- Run in Supabase SQL Editor only when you intend a fresh start.
-- Does NOT delete staff, branches, or auth users.

begin;

-- Bypass BIR immutability triggers for this maintenance wipe
do $$
declare
  r record;
begin
  for r in
    select tgname
    from pg_trigger
    where tgrelid = 'public.transactions'::regclass
      and not tgisinternal
  loop
    execute format('alter table public.transactions disable trigger %I', r.tgname);
  end loop;
  for r in
    select tgname
    from pg_trigger
    where tgrelid = 'public.transaction_items'::regclass
      and not tgisinternal
  loop
    execute format('alter table public.transaction_items disable trigger %I', r.tgname);
  end loop;
end $$;

delete from promo_rule_products;

do $$ begin
  delete from sale_refund_lines;
exception when undefined_table then null;
end $$;

delete from transaction_items;
delete from stock_movements;
delete from import_batch_items;
delete from branch_inventory;
delete from transactions;

delete from products;
delete from catalog_products;

delete from import_batches;

-- Re-enable BIR / sales guards
do $$
declare
  r record;
begin
  for r in
    select tgname
    from pg_trigger
    where tgrelid = 'public.transactions'::regclass
      and not tgisinternal
  loop
    execute format('alter table public.transactions enable trigger %I', r.tgname);
  end loop;
  for r in
    select tgname
    from pg_trigger
    where tgrelid = 'public.transaction_items'::regclass
      and not tgisinternal
  loop
    execute format('alter table public.transaction_items enable trigger %I', r.tgname);
  end loop;
end $$;

commit;

-- Next: Manager → Data → Import CSV into Network catalog,
-- then supervisors adopt items onto each branch from Catalog.
