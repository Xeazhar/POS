-- Run this if products already exists without branch_id
-- Makes catalog per-branch (SKU/barcode unique within a branch only)
-- Safe to re-run (idempotent)

alter table products add column if not exists branch_id uuid references branches(id) on delete cascade;

update products p
set branch_id = bi.branch_id
from branch_inventory bi
where bi.product_id = p.id and p.branch_id is null;

update products
set branch_id = (select id from branches order by created_at limit 1)
where branch_id is null;

alter table products alter column branch_id set not null;

alter table products drop constraint if exists products_sku_key;
alter table products drop constraint if exists products_barcode_key;

-- Unique indexes show up as relation "already exists" (42P07 / duplicate_table)
do $$ begin
  alter table products add constraint products_branch_id_sku_key unique (branch_id, sku);
exception
  when duplicate_object then null;
  when duplicate_table then null;
end $$;

do $$ begin
  alter table products add constraint products_branch_id_barcode_key unique (branch_id, barcode);
exception
  when duplicate_object then null;
  when duplicate_table then null;
end $$;

create index if not exists idx_products_branch on products(branch_id);

drop policy if exists "read products" on products;
drop policy if exists "write products" on products;
create policy "read products" on products for select to authenticated
  using (
    (branch_id = public.current_staff_branch() and is_active = true)
    or public.is_manager()
  );
create policy "write products" on products for all to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());
