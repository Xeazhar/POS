-- Tag catalog products as retail vs restaurant so branches only see their type

alter table catalog_products add column if not exists branch_type text;

update catalog_products
set branch_type = case
  when menu_kind is not null then 'restaurant'
  else 'retail'
end
where branch_type is null;

alter table catalog_products alter column branch_type set default 'retail';
alter table catalog_products drop constraint if exists catalog_products_branch_type_check;
alter table catalog_products add constraint catalog_products_branch_type_check
  check (branch_type in ('retail', 'restaurant'));

create index if not exists idx_catalog_products_branch_type on catalog_products(branch_type);

-- Harden adopt: only allow catalog rows matching the branch type
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
