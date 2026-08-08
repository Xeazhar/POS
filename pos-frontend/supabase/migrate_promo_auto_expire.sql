-- Auto-deactivate promo events once their end date passes, instead of leaving them
-- status='active' forever with the client just silently hiding them from POS
-- (respectDuration check in fetchActivePromoEventWithRules). Without this, an
-- expired promo kept counting as "live" in the Promos management UI, the
-- managing-dropdown, and notifications, even though it was no longer selling.
--
-- Called from the client at the top of the promo read paths (see src/lib/api.js
-- fetchActivePromoEventsWithRules / fetchActivePromosAcrossBranches) — a cheap
-- self-healing sweep on every read rather than a scheduled job, so it works
-- without pg_cron or any other Supabase-tier-dependent infrastructure.

create or replace function public.expire_ended_promos()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update promo_events
  set status = 'stopped',
      is_active = false,
      stopped_at = now(),
      stop_reason = coalesce(stop_reason, 'Promo ended')
  where status in ('active', 'stop_pending')
    and ends_at is not null
    and ends_at < now();
end;
$$;

grant execute on function public.expire_ended_promos() to authenticated;
