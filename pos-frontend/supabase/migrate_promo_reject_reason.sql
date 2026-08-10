-- Reject reason for promo creation requests: mirrors the stop_reason dual-control pattern
-- (migrate_promo_dual_control.sql, request_stop_promo) so a rejected promo shows why, the
-- same way a stopped one does.

alter table promo_events add column if not exists reject_reason text;

drop function if exists public.reject_promo_event(uuid, uuid);

create or replace function public.reject_promo_event(p_promo_event_id uuid, p_staff_id uuid, p_reason text)
returns public.promo_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.promo_events;
  v_reason text;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reject promos';
  end if;

  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Reject reason is required';
  end if;

  update promo_events
  set status = 'rejected',
      is_active = false,
      approved_by = p_staff_id,
      approved_at = now(),
      reject_reason = v_reason
  where id = p_promo_event_id
    and status = 'pending'
  returning * into v_row;

  if not found then
    raise exception 'No pending promo found to reject';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'promo_rejected',
    'Rejected promo: ' || v_row.name || ' — ' || left(v_reason, 200),
    jsonb_build_object('promo_event_id', v_row.id, 'reason', v_reason)
  );

  return v_row;
end;
$$;

grant execute on function public.reject_promo_event(uuid, uuid, text) to authenticated;
