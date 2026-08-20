-- expire_ended_promos() was gated to is_manager() (manager/admin/master), but
-- roles.js DEFAULTS grants supervisors the 'manager_promos' module too — a
-- supervisor viewing Promos.jsx triggers fetchPromoEventsForBranch ->
-- expireEndedPromos() -> this RPC, which raised 'Not authorized' (P0001) and
-- got swallowed by the try/catch in api.js. Harmless (promo display truth
-- already hides ended promos client-side), but it skipped the write-on-read
-- expire sweep for supervisors and spammed Postgres logs. Widen the gate to
-- match the module grant.

create or replace function public.expire_ended_promos()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_supervisor_or_above() then
    raise exception 'Not authorized';
  end if;

  update promo_events
  set status = 'expired',
      stopped_at = coalesce(stopped_at, now())
  where status in ('active', 'stop_pending')
    and ends_at is not null
    and ends_at < now();
end;
$$;

notify pgrst, 'reload schema';
