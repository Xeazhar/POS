-- Allow multiple concurrent active promo events per branch.
-- Previously: uq_promo_events_one_live_per_branch forced at most one
-- active/stop_pending promo_events row per branch_id, and approve_promo_event()
-- explicitly deactivated any other live promo on the branch before activating
-- the new one. Both are removed here so several promos can run at once;
-- POS applies the best (highest) discount per line across all of them —
-- see src/utils/promo.js computePromoDiscounts.

drop index if exists uq_promo_events_one_live_per_branch;
drop index if exists uniq_active_promo_event_per_branch;

create or replace function public.approve_promo_event(p_promo_event_id uuid, p_staff_id uuid)
returns public.promo_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.promo_events;
begin
  if not public.is_manager() then
    raise exception 'Only managers can approve promos';
  end if;

  update promo_events
  set status = 'active',
      is_active = true,
      approved_by = p_staff_id,
      approved_at = now()
  where id = p_promo_event_id
    and status = 'pending'
  returning * into v_row;

  if not found then
    raise exception 'No pending promo found to approve';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'promo_approved',
    'Approved promo: ' || v_row.name,
    jsonb_build_object('promo_event_id', v_row.id)
  );

  return v_row;
end;
$$;

grant execute on function public.approve_promo_event(uuid, uuid) to authenticated;
