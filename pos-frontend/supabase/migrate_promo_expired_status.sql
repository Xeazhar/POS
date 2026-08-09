-- Separate "expired" (ran to its end date) from "stopped" (a manager ended it early).
--
-- THE PROBLEM: expire_ended_promos() wrote status='stopped' when a promo simply reached
-- its end date, and the manual stop flow writes status='stopped' too. The two outcomes
-- are stored as the same value, so no badge, filter or report could tell them apart —
-- "we cancelled that promo" and "that promo finished normally" looked identical in the
-- history. That is a real reporting distinction: one is a decision, the other is a
-- schedule running out.
--
-- Apply AFTER migrate_promo_dual_control.sql and migrate_promo_auto_expire.sql.
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Allow the new status
-- ---------------------------------------------------------------------------
alter table promo_events drop constraint if exists promo_events_status_check;
alter table promo_events add constraint promo_events_status_check
  check (status in ('draft', 'pending', 'active', 'rejected', 'stop_pending', 'stopped', 'expired'));

-- ---------------------------------------------------------------------------
-- 2) The sweep now expires rather than stops
-- ---------------------------------------------------------------------------
-- Same self-healing-on-read design as before (no pg_cron dependency) — only the value it
-- writes changes. stop_reason is left null: "Promo ended" was only ever there to explain
-- a misleading 'stopped', and the status now says it directly.
create or replace function public.expire_ended_promos()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update promo_events
  set status = 'expired',
      is_active = false,
      stopped_at = coalesce(stopped_at, now())
  where status in ('active', 'stop_pending')
    and ends_at is not null
    and ends_at < now();
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Backfill history
-- ---------------------------------------------------------------------------
-- Rows the old sweep mislabelled are identifiable two ways, and both must hold:
--   * stopped_by is null  — the sweep never set it; every manual stop does
--   * stop_reason = 'Promo ended' — the literal string the old sweep wrote
-- Requiring both means a manager who happened to type "Promo ended" as their reason is
-- still recorded as a manual stop, which is what actually happened.
update promo_events
set status = 'expired',
    stop_reason = null
where status = 'stopped'
  and stopped_by is null
  and stop_reason = 'Promo ended';

-- Anything still 'stopped' whose end date passed but which nobody is recorded as having
-- stopped is also an expiry — older rows predating stop_reason being written at all.
update promo_events
set status = 'expired'
where status = 'stopped'
  and stopped_by is null
  and stop_reason is null
  and ends_at is not null
  and ends_at < now();

create index if not exists idx_promo_events_status_branch
  on promo_events (branch_id, status);

-- Verify
--   select status, count(*) from promo_events group by status;
--   -- a stopped promo should now always have a stopped_by; an expired one should not:
--   select id, name, status, stopped_by, stop_reason, ends_at from promo_events
--   where status in ('stopped', 'expired') order by stopped_at desc;
