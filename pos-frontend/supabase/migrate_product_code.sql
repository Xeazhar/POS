-- Human-friendly product numbers per branch (0001, 0002, …) for tracking / reports.
-- Internal UUID (products.id) remains the Power BI join key.

alter table products
  add column if not exists product_no integer;

-- Backfill existing rows in create order
with ranked as (
  select
    id,
    row_number() over (partition by branch_id order by created_at nulls last, id) as rn
  from products
  where product_no is null
)
update products p
set product_no = ranked.rn
from ranked
where p.id = ranked.id
  and p.product_no is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'products_branch_product_no_key'
  ) then
    alter table products
      add constraint products_branch_product_no_key unique (branch_id, product_no);
  end if;
end $$;

create or replace function assign_product_no()
returns trigger
language plpgsql
as $$
begin
  if new.product_no is null then
    select coalesce(max(product_no), 0) + 1
      into new.product_no
    from products
    where branch_id = new.branch_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assign_product_no on products;
create trigger trg_assign_product_no
  before insert on products
  for each row
  execute function assign_product_no();

comment on column products.product_no is
  'Per-branch sequential number shown as 0001, 0002, … for tracking; products.id is the stable UUID.';

notify pgrst, 'reload schema';
