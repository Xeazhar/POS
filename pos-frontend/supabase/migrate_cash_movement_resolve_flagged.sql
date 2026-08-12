-- Manager-only: flagged_for_investigation → confirmed (Resolved).
-- Prerequisite: migrate_cash_movements.sql
-- Safe to re-run.

do $$
begin
  if to_regclass('public.cash_movements') is null then
    raise exception 'cash_movements missing — apply migrate_cash_movements.sql first';
  end if;
end $$;

-- Allow review_action 'resolved' as alias of confirming a flagged row (stored as confirmed).
-- Keep check: confirmed | flagged_for_investigation (status stays confirmed).

create or replace function public.resolve_flagged_cash_movement(
  p_id uuid,
  p_resolved_by uuid,
  p_notes text default null
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cash_movements%rowtype;
begin
  if not public.is_manager() then
    raise exception 'MOVE21: only a manager can resolve a flagged movement';
  end if;

  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'flagged_for_investigation' then
    raise exception 'MOVE22: only flagged movements can be resolved this way';
  end if;
  if p_resolved_by is null then
    raise exception 'MOVE19: resolver required';
  end if;

  update public.cash_movements
  set status = 'confirmed',
      reviewed_by = p_resolved_by,
      reviewed_at = now(),
      review_action = 'confirmed',
      review_notes = case
        when nullif(trim(coalesce(p_notes, '')), '') is null then review_notes
        when review_notes is null or length(trim(review_notes)) = 0 then nullif(trim(p_notes), '')
        else review_notes || E'\n' || nullif(trim(p_notes), '')
      end
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_resolved_by, 'cash_movement_resolved',
    'Resolved flagged ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id, 'from_status', 'flagged_for_investigation')
  );

  return v_row;
end;
$$;

grant execute on function public.resolve_flagged_cash_movement(uuid, uuid, text) to authenticated;
