-- Reconcile name/sku/barcode/category_id: catalog_products -> products.
--
-- WHY: ManagerNetworkCatalog edits used to be template-only — saving name/SKU/barcode/
-- category in the network catalog never touched an already-adopted branch's products row, so
-- the branch (and every report, which reads products, never catalog_products) kept showing
-- the pre-edit value. api.cascadeCatalogFieldsToBranches (called from ManagerNetworkCatalog's
-- saveEditor) now pushes these fields forward on every future save, same reach as the existing
-- Discountable cascade. This migration is the one-time catch-up for edits made before that
-- cascade existed.
--
-- Price and budget_price are deliberately NOT touched here. Going forward, editing price in
-- the network catalog does cascade live (and logs a Price Change Register entry per branch),
-- but a bulk one-time price overwrite across every branch with no per-branch review is a
-- bigger fiscal action than this catch-up should take silently. This file only reconciles
-- name/SKU/barcode/category, none of which affect what a customer pays.
--
-- SKU is a (branch_id, sku) unique pair. If a branch already has an unrelated local product
-- using the SKU a catalog item is being renamed to, the UPDATE below fails on that constraint
-- (the whole statement rolls back) — resolve the conflicting row by hand and re-run.
--
-- Matches migrate_sync_discount_eligible.sql's shape: linked rows only (catalog_product_id);
-- unlinked rows are reported, not guessed at.
--
-- Safe to re-run — only writes rows that actually differ.

do $$
declare
  v_mismatch integer;
begin
  select count(*) into v_mismatch
  from products p
  join catalog_products c on c.id = p.catalog_product_id
  where p.name is distinct from c.name
     or p.sku is distinct from c.sku
     or p.barcode is distinct from c.barcode
     or p.category_id is distinct from c.category_id;

  raise notice 'products whose name/sku/barcode/category disagree with the catalog: %', v_mismatch;
end $$;

update products p
set name = c.name,
    sku = c.sku,
    barcode = c.barcode,
    category_id = c.category_id
from catalog_products c
where p.catalog_product_id = c.id
  and (
    p.name is distinct from c.name
    or p.sku is distinct from c.sku
    or p.barcode is distinct from c.barcode
    or p.category_id is distinct from c.category_id
  );

-- Confirm we are clean, and surface anything the join could not reach.
do $$
declare
  v_left integer;
  v_unlinked integer;
begin
  select count(*) into v_left
  from products p
  join catalog_products c on c.id = p.catalog_product_id
  where p.name is distinct from c.name
     or p.sku is distinct from c.sku
     or p.barcode is distinct from c.barcode
     or p.category_id is distinct from c.category_id;

  select count(*) into v_unlinked from products where catalog_product_id is null;

  raise notice 'remaining mismatches: % (expected 0)', v_left;

  if v_unlinked > 0 then
    raise warning 'products with no catalog link: % — these cannot be reconciled here. Run migrate_backfill_catalog_links.sql first, then re-run this file.', v_unlinked;
  end if;
end $$;
