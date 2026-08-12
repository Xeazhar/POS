-- Receive cashier shift handoff at day end.
--
-- Cashier end-shift closes with ending_cash NULL (Pending handoff). Supervisor confirms
-- receipt before Close day — this RPC fills ending/expected/variance from the shift's
-- recorded components (float + sales − outs) so Staff no longer shows Pending handoff.
-- Bypass staff_shifts_freeze_closed the same way adjust_shift_cash does.
--
-- Prerequisite: migrate_shift_cash_accountability.sql (staff_shifts cash cols + freeze trigger)

create or replace function public.receive_shift_handoff(
  p_shift_id uuid,
  p_received_by uuid default null
)
returns public.staff_shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.staff_shifts%rowtype;
  v_expected numeric(12,2);
  v_actor uuid := coalesce(p_received_by, public.current_staff_id());
  v_row public.staff_shifts%rowtype;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'SHIFT_NOT_ALLOWED: only a supervisor or manager can receive a handoff';
  end if;

  select * into v_shift from public.staff_shifts where id = p_shift_id for update;
  if not found then
    raise exception 'SHIFT_NOT_FOUND: no shift with id %', p_shift_id;
  end if;

  if not (v_shift.branch_id = public.current_staff_branch() or public.is_manager()) then
    raise exception 'SHIFT_NOT_ALLOWED: that shift belongs to another branch';
  end if;

  if v_shift.clock_out is null then
    raise exception 'SHIFT_STILL_OPEN: close the shift before receiving handoff';
  end if;

  if v_shift.holds_drawer is false then
    raise exception 'SHIFT_NO_DRAWER: floor shifts have no drawer handoff';
  end if;

  -- Already received / counted — idempotent success.
  if v_shift.ending_cash is not null then
    return v_shift;
  end if;

  v_expected := round(
    coalesce(v_shift.starting_cash, 0)
      + coalesce(v_shift.cash_sales, 0)
      - coalesce(v_shift.cash_refunds, 0)
      - coalesce(v_shift.cash_paid_out, 0)
      - coalesce(v_shift.cash_pickups, 0),
    2
  );

  insert into public.shift_adjustments (
    shift_id, branch_id, field, old_value, new_value, reason, adjusted_by, approved_by
  ) values (
    p_shift_id,
    v_shift.branch_id,
    'ending_cash',
    null,
    v_expected,
    'Handoff received — drawer counted at day end',
    v_actor,
    v_actor
  );

  perform set_config('calepos.shift_adjustment', 'on', true);

  update public.staff_shifts
  set ending_cash = v_expected,
      expected_cash = v_expected,
      variance = 0
  where id = p_shift_id
  returning * into v_row;

  perform set_config('calepos.shift_adjustment', 'off', true);

  return v_row;
end;
$$;

revoke execute on function public.receive_shift_handoff(uuid, uuid) from public, anon;
grant execute on function public.receive_shift_handoff(uuid, uuid) to authenticated;
