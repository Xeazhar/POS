-- Track product price changes in stock_movements (appears in movement history)

alter table stock_movements
  add column if not exists old_price numeric(10,2);

alter table stock_movements
  add column if not exists new_price numeric(10,2);

alter table stock_movements drop constraint if exists stock_movements_movement_type_check;
alter table stock_movements
  add constraint stock_movements_movement_type_check
  check (movement_type in ('restock', 'sale', 'adjustment', 'shrinkage', 'update', 'price_change'));

create or replace function public.record_price_change(
  p_branch_id uuid,
  p_product_id uuid,
  p_staff_id uuid,
  p_old_price numeric,
  p_new_price numeric,
  p_detail text default null
)
returns public.stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock numeric;
  v_movement public.stock_movements;
begin
  if p_old_price is not distinct from p_new_price then
    return null;
  end if;

  select quantity_on_hand into v_stock
  from branch_inventory
  where branch_id = p_branch_id and product_id = p_product_id;

  v_stock := coalesce(v_stock, 0);

  insert into stock_movements (
    branch_id, product_id, staff_id, movement_type, reference, detail,
    quantity_in, quantity_out, quantity_on_hand_after, old_price, new_price
  ) values (
    p_branch_id, p_product_id, p_staff_id, 'price_change', 'price',
    coalesce(p_detail, 'Price update'),
    0, 0, v_stock, p_old_price, p_new_price
  )
  returning * into v_movement;

  return v_movement;
end;
$$;

grant execute on function public.record_price_change(uuid, uuid, uuid, numeric, numeric, text) to authenticated;
