-- A cashier who hits the "Day closed" screen (ShiftGate — see migrate_staff_identity_resolve.sql
-- era frontend change) has no way to act except sign out. Reopening is deliberately
-- manager-only (reopen_day_end, migrate_day_end_dual_control.sql) — a cashier or supervisor
-- cannot and should not be able to unlock a filed closing themselves — but they need SOME way
-- to ask for it instead of being stuck. This adds a request, mirroring the existing
-- request_day_end() → day_ends.status='requested' pattern already used for the close side.
--
-- PREREQUISITE: migrate_day_end_dual_control.sql (day_ends, reopen_day_end),
-- migrate_day_end_supervisor_autoclose.sql (latest submit_day_end body — this file supersedes
-- both reopen_day_end and submit_day_end again, so apply this AFTER both).
--
-- Safe to re-run.

alter table public.day_ends
  add column if not exists reopen_requested_at timestamptz,
  add column if not exists reopen_requested_by uuid references public.staff(id),
  add column if not exists reopen_request_reason text;

-- ── Anyone on the branch (or a manager) can ask — the closed day already blocks them from
-- starting a shift, so this is their only path back to work short of a manager noticing on
-- their own. ─────────────────────────────────────────────────────────────────────────────
create or replace function public.request_day_reopen(
  p_day_end_id uuid,
  p_staff_id uuid,
  p_reason text
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
  select * into v_row from day_ends where id = p_day_end_id for update;
  if not found then
    raise exception 'Day-end record not found';
  end if;

  if v_row.branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized for this branch';
  end if;

  if v_row.status is distinct from 'closed' then
    raise exception 'Only a closed day can have a reopen requested';
  end if;

  v_reason := nullif(trim(p_reason), '');

  update day_ends
  set
    reopen_requested_at = now(),
    reopen_requested_by = p_staff_id,
    reopen_request_reason = v_reason
  where id = p_day_end_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_reopen_requested',
    'Requested reopen for ' || v_row.business_date::text
      || coalesce(': ' || left(v_reason, 200), ''),
    jsonb_build_object('day_end_id', v_row.id, 'business_date', v_row.business_date, 'reason', v_reason)
  );

  return v_row;
end;
$$;

grant execute on function public.request_day_reopen(uuid, uuid, text) to authenticated;

-- ── reopen_day_end: supersedes migrate_day_end_dual_control.sql's body — same behaviour,
-- plus clearing the request columns above once it's actually fulfilled. ───────────────────
create or replace function public.reopen_day_end(
  p_day_end_id uuid,
  p_staff_id uuid,
  p_reason text
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
  if not public.is_manager() then
    raise exception 'Only managers can reopen the till';
  end if;

  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Reopen reason is required';
  end if;

  update day_ends
  set
    status = 'reopened',
    reopened_at = now(),
    reopened_by = p_staff_id,
    reopen_reason = v_reason,
    reopen_requested_at = null,
    reopen_requested_by = null,
    reopen_request_reason = null
  where id = p_day_end_id
    and status = 'closed'
  returning * into v_row;

  if not found then
    raise exception 'Only a closed day can be reopened';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_reopen',
    'Reopened till for ' || v_row.business_date::text || ': ' || left(v_reason, 200),
    jsonb_build_object(
      'day_end_id', v_row.id,
      'business_date', v_row.business_date,
      'reason', v_reason
    )
  );

  return v_row;
end;
$$;

-- ── submit_day_end: supersedes migrate_day_end_supervisor_autoclose.sql's body — same
-- behaviour, plus clearing a stale reopen request when the day gets (re-)closed, same
-- reasoning it already clears reopened_at/reopened_by/reopen_reason on that branch. ───────
create or replace function public.submit_day_end(
  p_branch_id uuid,
  p_staff_id uuid,
  p_business_date date,
  p_recorded_cash numeric,
  p_cash_on_hand numeric,
  p_variance numeric,
  p_expected_cash numeric,
  p_note text default null,
  p_day_report jsonb default null,
  p_day_end_id uuid default null
)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized for this branch';
  end if;

  select * into v_row
  from day_ends
  where branch_id = p_branch_id
    and business_date = p_business_date
  for update;

  if found and v_row.status = 'closed' then
    raise exception 'Day is already closed';
  end if;

  if found then
    update day_ends
    set
      staff_id = p_staff_id,
      recorded_cash = p_recorded_cash,
      cash_on_hand = p_cash_on_hand,
      variance = p_variance,
      expected_cash = p_expected_cash,
      note = p_note,
      day_report = coalesce(p_day_report, day_report),
      status = 'submitted',
      submitted_at = now(),
      submitted_by = p_staff_id,
      approved_at = null,
      approved_by = null,
      closed_at = coalesce(closed_at, now()),
      reopened_at = null,
      reopened_by = null,
      reopen_reason = null,
      reopen_requested_at = null,
      reopen_requested_by = null,
      reopen_request_reason = null
    where id = v_row.id
    returning * into v_row;
  else
    insert into day_ends (
      branch_id, staff_id, business_date,
      recorded_cash, cash_on_hand, variance, expected_cash,
      note, day_report, status,
      submitted_at, submitted_by, closed_at
    ) values (
      p_branch_id, p_staff_id, p_business_date,
      p_recorded_cash, p_cash_on_hand, p_variance, p_expected_cash,
      p_note, p_day_report, 'submitted',
      now(), p_staff_id, now()
    )
    returning * into v_row;
  end if;

  -- The submitter IS a supervisor (or above): close it now rather than making them
  -- approve their own submission as a second step. approve_day_end does the audit_events
  -- insert and sets approved_at/approved_by, so this reads on every later report exactly
  -- like a normal approval — just by the same person, in one action instead of two.
  if public.is_supervisor_or_above() then
    return public.approve_day_end(v_row.id, p_staff_id);
  end if;

  return v_row;
end;
$$;

grant execute on function public.submit_day_end(uuid, uuid, date, numeric, numeric, numeric, numeric, text, jsonb, uuid) to authenticated;

notify pgrst, 'reload schema';

-- Verify
--   as a cashier, on a closed day: select * from public.request_day_reopen('<day_end id>', '<your staff id>', 'need to fix a miscount');
--   as a manager: select reopen_requested_at, reopen_requested_by, reopen_request_reason from public.day_ends where id = '<day_end id>';
