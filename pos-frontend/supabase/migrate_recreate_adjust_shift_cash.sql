-- Recreate public.adjust_shift_cash — dropped/never-created on some environments.
--
-- WHY
-- ---
-- migrate_shift_cash_accountability.sql applies every statement in one paste; on at
-- least one environment (CalePOS Dev) that left staff_shifts, shift_adjustments, and
-- every other function it defines (open_staff_shift, close_staff_shift,
-- shift_cash_summary, staff_shifts_freeze_closed) in place, but adjust_shift_cash
-- itself was never created — the shift correction screen fails with:
--   Could not find the function public.adjust_shift_cash(...) in the schema cache
--   (code SHIFT03)
--
-- This file re-creates ONLY that function (byte-for-byte the block from
-- migrate_shift_cash_accountability.sql section 8), plus its grant/revoke. It does not
-- touch any table, column, or other function.
--
-- PREREQUISITES:
--   migrate_shift_cash_accountability.sql (staff_shifts cash columns, shift_adjustments
--   table, staff_shifts_freeze_closed trigger, is_supervisor_or_above(),
--   current_staff_id(), current_staff_branch())
--
-- Safe to re-run.

create or replace function public.adjust_shift_cash(
  p_shift_id uuid,
  p_field text,
  p_new_value numeric,
  p_reason text,
  p_approved_by uuid default null
)
returns public.staff_shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.staff_shifts%rowtype;
  v_old numeric(12,2);
  v_expected numeric(12,2);
  v_ending numeric(12,2);
  v_actor uuid := public.current_staff_id();
  v_row public.staff_shifts%rowtype;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'SHIFT_NOT_ALLOWED: only a supervisor or manager can adjust a shift';
  end if;

  if p_field not in ('starting_cash', 'ending_cash') then
    raise exception 'SHIFT_BAD_FIELD: % cannot be adjusted', p_field;
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'SHIFT_REASON_REQUIRED: a written reason is required for an adjustment';
  end if;

  if p_new_value is null or p_new_value < 0 then
    raise exception 'SHIFT_BAD_AMOUNT: the corrected amount must be zero or more';
  end if;

  select * into v_shift from public.staff_shifts where id = p_shift_id;
  if not found then
    raise exception 'SHIFT_NOT_FOUND: no shift with id %', p_shift_id;
  end if;

  if not (v_shift.branch_id = public.current_staff_branch() or public.is_manager()) then
    raise exception 'SHIFT_NOT_ALLOWED: that shift belongs to another branch';
  end if;

  v_old := case when p_field = 'starting_cash' then v_shift.starting_cash else v_shift.ending_cash end;

  insert into public.shift_adjustments (
    shift_id, branch_id, field, old_value, new_value, reason, adjusted_by, approved_by
  ) values (
    p_shift_id, v_shift.branch_id, p_field, v_old, round(p_new_value, 2),
    trim(p_reason), v_actor, p_approved_by
  );

  -- Recompute the derived figures from whichever of the two counts just changed. The
  -- component totals (sales/refunds/paid-out/pickups) are untouched — an adjustment
  -- corrects a COUNT, never the sales record behind it.
  if p_field = 'starting_cash' then
    v_expected := round(
      round(p_new_value, 2) + coalesce(v_shift.cash_sales, 0) - coalesce(v_shift.cash_refunds, 0)
      - coalesce(v_shift.cash_paid_out, 0) - coalesce(v_shift.cash_pickups, 0), 2);
    v_ending := coalesce(v_shift.ending_cash, 0);
  else
    v_expected := coalesce(v_shift.expected_cash, 0);
    v_ending := round(p_new_value, 2);
  end if;

  perform set_config('calepos.shift_adjustment', 'on', true);

  update public.staff_shifts
  set starting_cash = case when p_field = 'starting_cash' then round(p_new_value, 2) else starting_cash end,
      ending_cash = case when p_field = 'ending_cash' then round(p_new_value, 2) else ending_cash end,
      expected_cash = case when clock_out is null then expected_cash else v_expected end,
      variance = case when clock_out is null then variance else round(v_ending - v_expected, 2) end
  where id = p_shift_id
  returning * into v_row;

  perform set_config('calepos.shift_adjustment', 'off', true);

  return v_row;
end $$;

revoke execute on function public.adjust_shift_cash(uuid, text, numeric, text, uuid) from public, anon;
grant execute on function public.adjust_shift_cash(uuid, text, numeric, text, uuid) to authenticated;
