-- Import-batch revert flow (request/dismiss/revert) never wrote to audit_events, unlike
-- every other manager/supervisor approval flow (day_ends, cash_movements,
-- till_action_requests, promo_events, refund_requests). That made it the one notification
-- category invisible to the notification history report. Re-declares the three functions
-- from migrate_import_batches.sql and migrate_import_revert_request.sql unchanged except
-- for the added audit_events insert.
--
-- Apply after migrate_import_batches.sql and migrate_import_revert_request.sql.
-- Safe to re-run.

create or replace function public.request_import_revert(p_batch_id uuid, p_staff_id uuid)
returns public.import_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.import_batches;
begin
  select * into v_batch from import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Import batch not found';
  end if;
  if v_batch.branch_id <> public.current_staff_branch() and not public.is_manager() then
    raise exception 'Branch access denied';
  end if;
  if v_batch.status <> 'committed' then
    raise exception 'Only a committed import can have a revert requested';
  end if;

  update import_batches
  set status = 'revert_requested', revert_requested_by = p_staff_id, revert_requested_at = now()
  where id = p_batch_id
  returning * into strict v_batch;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_batch.branch_id, p_staff_id, 'import_revert_requested',
    'Requested revert of import ' || coalesce(v_batch.filename, ''),
    jsonb_build_object('import_batch_id', v_batch.id, 'filename', v_batch.filename)
  );

  return v_batch;
end;
$$;

create or replace function public.dismiss_import_revert_request(p_batch_id uuid, p_staff_id uuid)
returns public.import_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.import_batches;
begin
  if not public.is_manager() then
    raise exception 'Only managers can dismiss a revert request';
  end if;

  update import_batches
  set status = 'committed', revert_requested_by = null, revert_requested_at = null
  where id = p_batch_id and status = 'revert_requested'
  returning * into v_batch;

  if v_batch.id is null then
    raise exception 'Import batch not found or not pending a revert request';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_batch.branch_id, p_staff_id, 'import_revert_dismissed',
    'Dismissed revert request for import ' || coalesce(v_batch.filename, ''),
    jsonb_build_object('import_batch_id', v_batch.id, 'filename', v_batch.filename)
  );

  return v_batch;
end;
$$;

create or replace function public.revert_import_batch(p_batch_id uuid, p_staff_id uuid)
returns public.import_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.import_batches;
  v_item public.import_batch_items;
begin
  if not public.is_manager() then
    raise exception 'Only managers can revert imports';
  end if;

  select * into v_batch from import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Import batch not found';
  end if;
  if v_batch.status = 'reverted' then
    raise exception 'Import already reverted';
  end if;

  for v_item in
    select * from import_batch_items where batch_id = p_batch_id
  loop
    if v_item.quantity_added > 0 then
      perform public.record_stock_movement(
        v_batch.branch_id,
        v_item.product_id,
        p_staff_id,
        'adjustment',
        0,
        v_item.quantity_added,
        'revert:' || p_batch_id::text,
        'Revert import ' || coalesce(v_batch.filename, '')
      );
    end if;
    if v_item.action = 'create' then
      update products set is_active = false where id = v_item.product_id;
    end if;
  end loop;

  update import_batches
  set status = 'reverted', reverted_at = now(), reverted_by = p_staff_id
  where id = p_batch_id
  returning * into strict v_batch;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_batch.branch_id, p_staff_id, 'import_reverted',
    'Reverted import ' || coalesce(v_batch.filename, ''),
    jsonb_build_object('import_batch_id', v_batch.id, 'filename', v_batch.filename)
  );

  return v_batch;
end;
$$;

notify pgrst, 'reload schema';
