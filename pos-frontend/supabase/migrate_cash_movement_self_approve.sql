-- Let a supervisor/manager/master record their OWN Open Drawer activity (petty cash,
-- pickup, cash-in, opening float) as cleanly 'approved' — no PIN, no manager notify, no
-- flagged self-record. Dual control (approver must differ from requester) stays the rule
-- for a cashier: their request still needs a real second person or falls back to the
-- existing "no supervisor here? proceed without approval" flagged path. This is a
-- deliberate relaxation for the roles that already sit at or above the approval authority
-- itself — decided explicitly by the owner, not a default; see the PR that added this.
--
-- Server-side is the actual control: `is_supervisor_or_above()` reads the CALLING
-- session's own staff row (auth.uid()), not anything the client sends, so this cannot be
-- spoofed by a cashier passing their own id twice.
--
-- Prerequisite: migrate_cash_movement_cash_in.sql (supersedes create_cash_movement_approved's
-- body; only the MOVE04 check + audit `via` tag change — types, shift/branch checks, opening
-- float side effect are unchanged).
-- Safe to re-run.

create or replace function public.create_cash_movement_approved(
  p_shift_id uuid,
  p_branch_id uuid,
  p_drawer_id text,
  p_drawer_label text,
  p_type text,
  p_amount numeric,
  p_reason text,
  p_requested_by uuid,
  p_approved_by uuid,
  p_client_id uuid default null,
  p_created_offline boolean default false
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.staff_shifts%rowtype;
  v_row public.cash_movements%rowtype;
  v_self_approved boolean;
begin
  if not public.cash_movement_type_allowed(p_type) then
    raise exception 'MOVE01: invalid movement type';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'MOVE02: amount must be positive';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'MOVE03: reason is required';
  end if;
  if p_approved_by is null then
    raise exception 'MOVE04: supervisor approval required';
  end if;
  -- Null-safe: `=` against a null p_requested_by yields NULL, which the `and` below then
  -- silently treats as false rather than skipping the dual-control check — same reasoning
  -- as the branch_id/staff_id `is distinct from` checks a few lines down.
  v_self_approved := p_approved_by is not distinct from p_requested_by;
  if v_self_approved and not public.is_supervisor_or_above() then
    raise exception 'MOVE04: supervisor approval required';
  end if;

  select * into v_shift from public.staff_shifts where id = p_shift_id for update;
  if not found then
    raise exception 'MOVE05: shift not found';
  end if;
  if v_shift.clock_out is not null then
    raise exception 'MOVE06: shift is closed';
  end if;
  if v_shift.holds_drawer is false then
    raise exception 'MOVE07: floor shift cannot hold drawer cash';
  end if;
  if v_shift.branch_id is distinct from p_branch_id then
    raise exception 'MOVE08: branch mismatch';
  end if;
  if v_shift.staff_id is distinct from p_requested_by
     and not public.is_supervisor_or_above() then
    raise exception 'MOVE09: only the drawer holder can request';
  end if;

  perform public.validate_cash_movement_opening_float(p_shift_id, p_type);

  insert into public.cash_movements (
    client_id, shift_id, branch_id, drawer_id, drawer_label,
    type, amount, reason, requested_by, status,
    approved_by, approved_at, created_offline, synced_at
  ) values (
    p_client_id, p_shift_id, p_branch_id,
    coalesce(nullif(trim(p_drawer_id), ''), 'main'),
    coalesce(nullif(trim(p_drawer_label), ''), 'Main drawer'),
    p_type, round(p_amount, 2), trim(p_reason), p_requested_by, 'approved',
    p_approved_by, now(), coalesce(p_created_offline, false),
    case when coalesce(p_created_offline, false) then null else now() end
  )
  returning * into v_row;

  perform public.apply_counted_cash_movement_effects(v_row);

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_approved_by,
    case when v_self_approved then 'cash_movement_self_approved' else 'cash_movement_approved' end,
    (case when v_self_approved then 'Self-approved ' else 'Approved ' end)
      || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object(
      'cash_movement_id', v_row.id, 'type', v_row.type,
      'amount', v_row.amount, 'via', case when v_self_approved then 'self' else 'pin' end
    )
  );

  return v_row;
end;
$$;

notify pgrst, 'reload schema';
