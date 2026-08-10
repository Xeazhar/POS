-- Let a supervisor/manager decline a cashier's "Request day end" made by mistake.
--
-- WHY
-- ---
-- request_day_end() (migrate_day_end_request_no_shift_count.sql) lets a cashier flag a
-- business day for closing. Once flagged, the only way forward was to actually close it —
-- there was no way to say "not yet, that was a mistake" and hand the day back to normal
-- selling. This adds a 'rejected' status: the row is kept (not deleted) so the decline is on
-- record, same audit-trail approach as reopen_day_end keeping history instead of erasing it.
-- A cashier can request again immediately afterwards — request_day_end() already accepts
-- re-requesting over any row that isn't 'submitted'/'closed'.
--
-- PREREQUISITE: migrate_day_end_request_no_shift_count.sql (adds 'requested' status + columns).
--
-- Safe to re-run.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'day_ends' and column_name = 'requested_at'
  ) then
    raise exception 'day_ends.requested_at is missing — apply migrate_day_end_request_no_shift_count.sql first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. day_ends: record who declined a request, and why
-- ---------------------------------------------------------------------------
alter table public.day_ends add column if not exists rejected_at timestamptz;
alter table public.day_ends add column if not exists rejected_by uuid references public.staff(id) on delete set null;
alter table public.day_ends add column if not exists reject_reason text;

comment on column public.day_ends.rejected_at is 'When a supervisor/manager declined a cashier''s day-end request.';
comment on column public.day_ends.reject_reason is 'Optional reason given for declining the request.';

alter table public.day_ends drop constraint if exists day_ends_status_check;
alter table public.day_ends add constraint day_ends_status_check
  check (status in ('requested', 'submitted', 'closed', 'reopened', 'rejected'));

-- ---------------------------------------------------------------------------
-- 2. reject_day_end_request(): only a pending 'requested' row can be declined
-- ---------------------------------------------------------------------------
create or replace function public.reject_day_end_request(
  p_day_end_id uuid,
  p_staff_id uuid,
  p_reason text default null
)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends;
  v_reason text;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'Only supervisors or managers can decline a day end request';
  end if;

  v_reason := nullif(trim(coalesce(p_reason, '')), '');

  update public.day_ends
  set status = 'rejected',
      rejected_at = now(),
      rejected_by = p_staff_id,
      reject_reason = v_reason,
      requested_at = null,
      requested_by = null,
      request_manager = false
  where id = p_day_end_id
    and status = 'requested'
  returning * into v_row;

  if not found then
    raise exception 'No pending day end request found to decline';
  end if;

  insert into public.audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_request_declined',
    'Declined day end request for ' || v_row.business_date::text
      || case when v_reason is not null then ': ' || left(v_reason, 200) else '' end,
    jsonb_build_object('day_end_id', v_row.id, 'business_date', v_row.business_date, 'reason', v_reason)
  );

  return v_row;
end;
$$;

grant execute on function public.reject_day_end_request(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';

-- Verify
--   select id, status, requested_at, rejected_at, reject_reason from public.day_ends
--   where business_date = current_date;
