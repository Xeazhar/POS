-- A supervisor's own day-end submission closes immediately — no separate approval step.
--
-- WHY
-- ---
-- migrate_day_end_dual_control.sql split closing into submit (any branch staff) then
-- approve (supervisor+). But the only screen that ever calls submit_day_end is
-- SupervisorDayEnd (DayEnd.jsx), which is already gated to supervisor+ — DayEnd() routes
-- anyone below supervisor to the separate CashierEndShift screen, which never touches
-- day_ends at all. So in practice the "approve" step was a supervisor approving their own
-- submission a moment later: dual control in name, one person in fact.
--
-- This makes submit_day_end auto-close when the caller is supervisor_or_above, by calling
-- approve_day_end on itself in the same statement — same audit_events row, same
-- approved_by/approved_at columns as a real approval, just skipping the round trip. If a
-- plain cashier ever calls this RPC (not exposed in the current UI, but the RPC itself does
-- not forbid it), the day still lands on 'submitted' and needs a supervisor+ to approve it —
-- the original two-person control is untouched for that caller.
--
-- PREREQUISITE: migrate_day_end_dual_control.sql (submit_day_end, approve_day_end).
--
-- Safe to re-run.

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
      reopen_reason = null
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
