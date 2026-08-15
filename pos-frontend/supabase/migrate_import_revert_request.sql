-- Supervisor-initiated "request revert" for a committed import batch.
--
-- Actual revert stays manager-only (revert_import_batch already enforces is_manager()) —
-- this only lets a supervisor flag a bad import for a manager's attention instead of
-- silently living with it until a manager happens to notice on their own. RLS on
-- import_batches is already branch-scoped for supervisors (see
-- migrate_import_batches_branch_staff.sql), so no policy changes are needed here.
--
-- Apply after migrate_import_batches.sql and migrate_import_batches_branch_staff.sql.
-- Safe to re-run.

alter table import_batches drop constraint if exists import_batches_status_check;
alter table import_batches add constraint import_batches_status_check
  check (status in ('committed', 'revert_requested', 'reverted'));

alter table import_batches add column if not exists revert_requested_by uuid references staff(id) on delete set null;
alter table import_batches add column if not exists revert_requested_at timestamptz;

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

  return v_batch;
end;
$$;

grant execute on function public.request_import_revert(uuid, uuid) to authenticated;

-- Manager clears a request without reverting — puts the batch back to 'committed' so it
-- reads as an ordinary import again (can be requested again later, or just left alone).
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

  return v_batch;
end;
$$;

grant execute on function public.dismiss_import_revert_request(uuid, uuid) to authenticated;

-- Reuse the same operations broadcast every other request-notify-manager flow uses
-- (refund_requests, till_action_requests, day_ends, ...) — see migrate_realtime_broadcast_v1.sql
-- section 6. import_batches wasn't in that table list originally, so attach it here.
drop trigger if exists trg_import_batches_ops_broadcast on public.import_batches;
create trigger trg_import_batches_ops_broadcast
  after insert or update or delete on public.import_batches
  for each row execute function public.tg_ops_broadcast();

notify pgrst, 'reload schema';
