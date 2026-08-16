-- CRITICAL: close an unauthenticated bypass caused by NULL-unsafe branch checks.
--
-- WHY
-- ---
-- record_stock_movement() and request_import_revert() both gate cross-branch access with:
--   if X.branch_id <> public.current_staff_branch() and not public.is_manager() then
--     raise exception ...
-- `<>` is NULL-unsafe: an anon caller has no staff row, so current_staff_branch() returns
-- NULL. `p_branch_id <> NULL` evaluates to NULL, `NULL and not is_manager()` evaluates to
-- NULL, and Postgres only raises the exception when the `if` condition is TRUE — NULL is
-- not TRUE, so the guard silently no-ops and the call proceeds.
--
-- request_import_revert is still directly granted to `anon` on both known environments as
-- of this migration, so this is a live unauthenticated bypass: anyone holding the public
-- anon key can flip any branch's committed import batch to `revert_requested` with an
-- arbitrary p_staff_id, no login required. record_stock_movement's anon grant should
-- already be revoked by migrate_revoke_anon_sale_rpc_grants.sql where applied; this closes
-- the same defect there too as defense in depth (and protects the `authenticated` path if a
-- staff row is ever transiently branchless).
--
-- FIX
-- ---
-- Use IS DISTINCT FROM (NULL-safe) instead of <>, and revoke the anon grant on
-- request_import_revert the same way migrate_revoke_anon_sale_rpc_grants.sql did for the
-- sale/inventory RPCs — `authenticated` keeps its grant, so real logged-in staff see no
-- behavior change.
--
-- Apply after migrate_import_revert_request.sql and migrate_sale_stock_update.sql. Safe to re-run.

create or replace function public.record_stock_movement(
  p_branch_id uuid,
  p_product_id uuid,
  p_staff_id uuid,
  p_movement_type text,
  p_quantity_in numeric,
  p_quantity_out numeric,
  p_reference text default null,
  p_detail text default null
)
returns public.stock_movements
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_stock numeric; v_movement public.stock_movements;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
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

create or replace function public.request_import_revert(p_batch_id uuid, p_staff_id uuid)
returns public.import_batches
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_batch public.import_batches;
begin
  select * into v_batch from import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Import batch not found';
  end if;
  if v_batch.branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Branch access denied';
  end if;
  if v_batch.status <> 'committed' then
    raise exception 'Only a committed import can have a revert requested';
  end if;

  update import_batches
  set status = 'revert_requested', revert_requested_by = p_staff_id, revert_requested_at = now()
  where id = p_batch_id
  returning * into strict v_batch;

  return v_batch;
end;
$$;

revoke all on function public.request_import_revert(uuid, uuid) from public, anon;

-- Verify (expect false, true):
--   select has_function_privilege('anon', 'public.request_import_revert(uuid, uuid)', 'EXECUTE');
--   select has_function_privilege('authenticated', 'public.request_import_revert(uuid, uuid)', 'EXECUTE');

notify pgrst, 'reload schema';
