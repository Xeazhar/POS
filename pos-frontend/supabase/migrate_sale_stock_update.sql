-- Allow sales to update stock even when on-hand would go negative
-- (prevents silent POS inventory lag when counts are off)

create or replace function public.record_stock_movement(
  p_branch_id uuid, p_product_id uuid, p_staff_id uuid, p_movement_type text,
  p_quantity_in numeric, p_quantity_out numeric, p_reference text default null, p_detail text default null
) returns public.stock_movements language plpgsql security definer set search_path = public as $$
declare v_stock numeric; v_movement public.stock_movements;
begin
  if p_branch_id <> public.current_staff_branch() and not public.is_manager() then
    raise exception 'Branch access denied';
  end if;
  insert into branch_inventory (branch_id, product_id, quantity_on_hand)
  values (p_branch_id, p_product_id, 0)
  on conflict (branch_id, product_id) do nothing;
  update branch_inventory
    set quantity_on_hand = quantity_on_hand + p_quantity_in - p_quantity_out, updated_at = now()
  where branch_id = p_branch_id and product_id = p_product_id
  returning quantity_on_hand into v_stock;
  insert into stock_movements (
    branch_id, product_id, staff_id, movement_type, reference, detail,
    quantity_in, quantity_out, quantity_on_hand_after
  ) values (
    p_branch_id, p_product_id, p_staff_id, p_movement_type, p_reference, p_detail,
    p_quantity_in, p_quantity_out, v_stock
  ) returning * into strict v_movement;
  return v_movement;
end;
$$;
