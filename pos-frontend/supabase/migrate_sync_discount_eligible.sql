-- Reconcile discount_eligible: catalog_products -> products.
--
-- WHY THIS IS SEPARATE FROM migrate_backfill_catalog_links.sql:
-- That migration repaired the *link* (products.catalog_product_id) and copied values
-- UPWARD when creating missing catalog rows. It never copied the flag DOWNWARD. So a
-- product whose catalog row was set "Discountable = Yes" before the cascade existed in the
-- app still has products.discount_eligible = false. Manager -> Data shows "Yes", the POS
-- cart says "not marked discountable", and re-running the link migration does not fix it —
-- only re-toggling each item by hand did, which does not scale.
--
-- Direction is deliberate. Per the app's documented convention (CLAUDE.md), the network
-- catalog is authoritative for Discountable specifically: toggling it there is expected to
-- reach every branch that already adopted the item. Price, name, etc. remain branch-local
-- and are NOT touched here.
--
-- Run once, after migrate_backfill_catalog_links.sql (that one establishes the links this
-- one joins on). Safe to re-run — it only writes rows that actually differ.

-- Report the damage first, so there is a before/after number rather than a silent fix.
do $$
declare
  v_mismatch integer;
begin
  select count(*) into v_mismatch
  from products p
  join catalog_products c on c.id = p.catalog_product_id
  where p.discount_eligible is distinct from c.discount_eligible;

  raise notice 'products whose Discountable disagrees with the catalog: %', v_mismatch;
end $$;

update products p
set discount_eligible = c.discount_eligible
from catalog_products c
where p.catalog_product_id = c.id
  and p.discount_eligible is distinct from c.discount_eligible;

-- Confirm we are clean, and surface anything the join could not reach.
do $$
declare
  v_left integer;
  v_unlinked integer;
begin
  select count(*) into v_left
  from products p
  join catalog_products c on c.id = p.catalog_product_id
  where p.discount_eligible is distinct from c.discount_eligible;

  select count(*) into v_unlinked from products where catalog_product_id is null;

  raise notice 'remaining mismatches: % (expected 0)', v_left;

  if v_unlinked > 0 then
    raise warning 'products with no catalog link: % — these cannot be reconciled. Run migrate_backfill_catalog_links.sql first, then re-run this file. Any still unlinked have no SKU to match on: select id, name from products where catalog_product_id is null;', v_unlinked;
  end if;
end $$;
