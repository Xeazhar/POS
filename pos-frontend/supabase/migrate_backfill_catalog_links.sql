-- Heal products.catalog_product_id, and stop it going stale again.
--
-- WHY: `catalog_product_id` is the join the network catalog uses to push a Discountable
-- change out to branches (api.js cascadeDiscountEligibleToBranches). It was only ever set
-- in one place — createProduct's best-effort mirror into catalog_products — and that path
-- has two holes:
--
--   1. Writing catalog_products requires is_manager(). A SUPERVISOR adding a product hits
--      RLS, the insert fails inside a try/catch that only console.warn()s, and the product
--      is left with a NULL link.
--   2. The bulk importer (commitInventoryImport) never set the column at all, so every
--      imported product has a NULL link.
--
-- Symptom this caused: a manager turns Discountable on in Manager -> Data, the save
-- succeeds, and POS never applies PWD/Senior to that item — because the cascade matched on
-- a column that was NULL for that row. Items adopted from the catalog worked (adopt_catalog_products
-- sets the link), which is why *some* products discounted correctly and others never did.
--
-- Run once. Safe to re-run: every statement is idempotent.

-- 1. Create catalog rows for any branch product that has no catalog counterpart at all.
--    Case/whitespace-insensitive on sku, matching how the original backfill compared them.
insert into catalog_products (
  category_id, name, sku, barcode, pricing_mode, price, budget_price,
  menu_kind, low_stock_threshold, discount_eligible, is_active, branch_type
)
select distinct on (lower(trim(p.sku)))
  p.category_id,
  p.name,
  trim(p.sku),
  nullif(trim(p.barcode), ''),
  p.pricing_mode,
  p.price,
  p.budget_price,
  p.menu_kind,
  p.low_stock_threshold,
  p.discount_eligible,
  true,
  case when p.menu_kind is not null then 'restaurant' else 'retail' end
from products p
where p.catalog_product_id is null
  and p.sku is not null
  and trim(p.sku) <> ''
  and not exists (
    select 1 from catalog_products c
    where lower(trim(c.sku)) = lower(trim(p.sku))
  )
order by lower(trim(p.sku)), p.created_at
on conflict (sku) do nothing;

-- 2. Link every unlinked branch product to its catalog row by sku.
update products p
set catalog_product_id = c.id
from catalog_products c
where p.catalog_product_id is null
  and p.sku is not null
  and trim(p.sku) <> ''
  and lower(trim(p.sku)) = lower(trim(c.sku));

-- 3. Keep it linked from here on, regardless of which code path or role creates the row.
--    A trigger closes the hole permanently: the client can forget (and the supervisor path
--    is not even permitted to write catalog_products), but this cannot be skipped.
create or replace function public.link_product_to_catalog()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.catalog_product_id is null and new.sku is not null and trim(new.sku) <> '' then
    select id into new.catalog_product_id
    from catalog_products
    where lower(trim(sku)) = lower(trim(new.sku))
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_link_product_to_catalog on products;
create trigger trg_link_product_to_catalog
  before insert or update of sku on products
  for each row execute function public.link_product_to_catalog();

-- 4. Report what is still unlinked (products with no sku can't be matched — expected).
do $$
declare
  v_unlinked integer;
begin
  select count(*) into v_unlinked from products where catalog_product_id is null;
  raise notice 'products still unlinked after backfill: % (rows without a sku cannot be matched)', v_unlinked;
end $$;
