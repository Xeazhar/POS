-- Allow the requester (or a manager) to cancel a pending_remote cash movement.
-- Used when the cashier closes the Open Drawer wait UI with X / Cancel.
-- Prerequisite: migrate_cash_movements.sql
-- Safe to re-run.

do $$
begin
  if to_regclass('public.cash_movements') is null then
    raise exception 'cash_movements missing — apply migrate_cash_movements.sql first';
  end if;
end $$;

create or replace function public.cancel_cash_movement(
  p_id uuid,
  p_cancelled_by uuid
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cash_movements%rowtype;
begin
  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;
  if v_row.requested_by is distinct from p_cancelled_by and not public.is_manager() then
    raise exception 'MOVE16: only requester or manager can cancel';
  end if;

  update public.cash_movements
  set status = 'voided',
      denied_by = p_cancelled_by,
      denied_at = now()
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_cancelled_by, 'cash_movement_cancelled',
    'Cancelled ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id)
  );

  return v_row;
end;
$$;

grant execute on function public.cancel_cash_movement(uuid, uuid) to authenticated;
