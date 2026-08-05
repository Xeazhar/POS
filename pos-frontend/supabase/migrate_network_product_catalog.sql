-- Network product catalog: managers own master list; branches adopt into products + inventory

create table if not exists catalog_products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references categories(id) on delete set null,
  name text not null,
  sku text not null,
  barcode text,
  pricing_mode text not null check (pricing_mode in ('per_unit', 'per_kg')),
  price numeric(10,2) not null check (price >= 0),
  budget_price numeric(10,2) check (budget_price is null or budget_price >= 0),
  menu_kind text check (menu_kind is null or menu_kind in ('meat', 'veggie', 'pancit', 'drink', 'rice', 'extra')),
  low_stock_threshold numeric(10,2) not null default 10,
  medium_stock_threshold numeric(10,2) not null default 30,
  discount_eligible boolean not null default true,
  is_active boolean not null default true,
  branch_type text not null default 'retail' check (branch_type in ('retail', 'restaurant')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sku)
);

create unique index if not exists uq_catalog_products_barcode
  on catalog_products (barcode)
  where barcode is not null and barcode <> '';

alter table products add column if not exists catalog_product_id uuid references catalog_products(id) on delete set null;

create index if not exists idx_products_catalog on products(catalog_product_id);

-- Seed catalog from existing products (prefer earliest created per sku)
insert into catalog_products (
  id, category_id, name, sku, barcode, pricing_mode, price, budget_price, menu_kind,
  low_stock_threshold, medium_stock_threshold, discount_eligible, is_active, branch_type, created_at
)
select distinct on (lower(trim(sku)))
  gen_random_uuid(),
  category_id,
  name,
  trim(sku),
  nullif(trim(barcode), ''),
  pricing_mode,
  price,
  budget_price,
  menu_kind,
  low_stock_threshold,
  medium_stock_threshold,
  discount_eligible,
  is_active,
  case when menu_kind is not null then 'restaurant' else 'retail' end,
  created_at
from products
where sku is not null and trim(sku) <> ''
order by lower(trim(sku)), created_at
on conflict (sku) do nothing;

-- Link branch products to catalog by sku
update products p
set catalog_product_id = c.id
from catalog_products c
where p.catalog_product_id is null
  and lower(trim(p.sku)) = lower(trim(c.sku));

alter table catalog_products enable row level security;

drop policy if exists "read catalog products" on catalog_products;
drop policy if exists "managers write catalog products" on catalog_products;

create policy "read catalog products" on catalog_products for select to authenticated
  using (true);

create policy "managers write catalog products" on catalog_products for all to authenticated
  using (public.is_manager())
  with check (public.is_manager());

-- Adopt selected catalog products into a branch (creates products + inventory rows)
create or replace function public.adopt_catalog_products(
  p_branch_id uuid,
  p_catalog_ids uuid[],
  p_staff_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_cat catalog_products%rowtype;
  v_product_id uuid;
  v_count integer := 0;
  v_branch_type text;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized for this branch';
  end if;

  select coalesce(branch_type, 'retail') into v_branch_type
  from branches where id = p_branch_id;

  foreach v_id in array p_catalog_ids
  loop
    select * into v_cat from catalog_products where id = v_id and is_active;
    if not found then
      continue;
    end if;

    if coalesce(v_cat.branch_type, 'retail') is distinct from coalesce(v_branch_type, 'retail') then
      continue;
    end if;

    -- Skip if branch already has this catalog product or same sku
    if exists (
      select 1 from products
      where branch_id = p_branch_id
        and (catalog_product_id = v_id or lower(trim(sku)) = lower(trim(v_cat.sku)))
    ) then
      continue;
    end if;

    insert into products (
      branch_id, catalog_product_id, category_id, name, sku, barcode,
      pricing_mode, price, budget_price, menu_kind,
      low_stock_threshold, medium_stock_threshold, discount_eligible, is_active
    ) values (
      p_branch_id, v_cat.id, v_cat.category_id, v_cat.name, v_cat.sku, v_cat.barcode,
      v_cat.pricing_mode, v_cat.price, v_cat.budget_price, v_cat.menu_kind,
      v_cat.low_stock_threshold, v_cat.medium_stock_threshold, v_cat.discount_eligible, true
    )
    returning id into v_product_id;

    insert into branch_inventory (branch_id, product_id, quantity_on_hand)
    values (p_branch_id, v_product_id, 0)
    on conflict (branch_id, product_id) do nothing;

    v_count := v_count + 1;
  end loop;

  if p_staff_id is not null and v_count > 0 then
    insert into audit_events (branch_id, staff_id, event_type, detail, meta)
    values (
      p_branch_id,
      p_staff_id,
      'catalog_adopt',
      'Adopted ' || v_count || ' catalog product(s) to branch',
      jsonb_build_object('count', v_count, 'catalog_ids', to_jsonb(p_catalog_ids))
    );
  end if;

  return v_count;
end;
$$;

grant execute on function public.adopt_catalog_products(uuid, uuid[], uuid) to authenticated;
