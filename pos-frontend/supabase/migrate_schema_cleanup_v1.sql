-- Schema cleanup v1 (load-path overhaul companion).
-- Apply AFTER full migrate order in README.md (through migrate_promo_rule_bundle_name.sql).
-- Safe to re-run. Does NOT touch staff credentials / Auth users.
--
-- Recommended: run wipe_non_user_data.sql on DEV first if you want a clean slate of
-- products/sales (staff + branches preserved).
--
-- What this does:
--   1) Drop duplicate client_id unique index (keep uq_transactions_branch_client)
--   2) Retire promo_events.is_active — status is sole lifecycle source
--   3) Drop dormant closed_without_supervisor + acknowledge_shift_review
--   4) Tighten refund_requests RLS (no client UPDATE; RPCs are security definer)
--   5) Align sale_events / audit_events RLS to is_manager() / current_staff_branch()
--   6) Drop legacy petty_cash if somehow still present after rename

-- ---------------------------------------------------------------------------
-- 1) Duplicate unique index on (branch_id, client_id)
-- ---------------------------------------------------------------------------
-- migrate_bir_pos_compliance.sql created uq_transactions_branch_client;
-- migrate_sale_dedupe_hardening.sql added uq_transactions_branch_client_id on the same
-- predicate. Keep the older name; drop the duplicate.
drop index if exists public.uq_transactions_branch_client_id;

-- ---------------------------------------------------------------------------
-- 2) Promo: status-only lifecycle (drop is_active)
-- ---------------------------------------------------------------------------
drop index if exists public.uniq_active_promo_event_per_branch;
drop index if exists public.uq_promo_events_one_live_per_branch;

create or replace function public.expire_ended_promos()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update promo_events
  set status = 'expired',
      stopped_at = coalesce(stopped_at, now())
  where status in ('active', 'stop_pending')
    and ends_at is not null
    and ends_at < now();
end;
$$;

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

create or replace function public.approve_stop_promo(p_promo_event_id uuid, p_staff_id uuid)
returns public.promo_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.promo_events;
begin
  if not public.is_manager() then
    raise exception 'Only managers can approve promo stop';
  end if;

  update promo_events
  set status = 'stopped',
      stopped_by = p_staff_id,
      stopped_at = now()
  where id = p_promo_event_id
    and status = 'stop_pending'
  returning * into v_row;

  if not found then
    raise exception 'No stop-pending promo found';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'promo_stopped',
    'Approved stop: ' || v_row.name,
    jsonb_build_object('promo_event_id', v_row.id, 'reason', v_row.stop_reason)
  );

  return v_row;
end;
$$;

create or replace function public.reject_stop_promo(p_promo_event_id uuid, p_staff_id uuid)
returns public.promo_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.promo_events;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reject promo stop';
  end if;

  update promo_events
  set status = 'active',
      stop_requested_by = null,
      stop_reason = null
  where id = p_promo_event_id
    and status = 'stop_pending'
  returning * into v_row;

  if not found then
    raise exception 'No stop-pending promo found';
  end if;

  return v_row;
end;
$$;

grant execute on function public.approve_promo_event(uuid, uuid) to authenticated;
grant execute on function public.reject_promo_event(uuid, uuid, text) to authenticated;
grant execute on function public.approve_stop_promo(uuid, uuid) to authenticated;
grant execute on function public.reject_stop_promo(uuid, uuid) to authenticated;
grant execute on function public.expire_ended_promos() to authenticated;

-- Drop column last (after RPCs no longer reference it)
alter table public.promo_events drop column if exists is_active;

-- ---------------------------------------------------------------------------
-- 3) Dormant shift "closed without supervisor" review path
-- ---------------------------------------------------------------------------
drop function if exists public.acknowledge_shift_review(uuid, uuid);

alter table public.staff_shifts drop column if exists closed_without_supervisor;
alter table public.staff_shifts drop column if exists reviewed_by;
alter table public.staff_shifts drop column if exists reviewed_at;

-- ---------------------------------------------------------------------------
-- 4) refund_requests: no client UPDATE (mutations via security definer RPCs)
-- ---------------------------------------------------------------------------
drop policy if exists "update refund requests" on public.refund_requests;
-- Keep SELECT + INSERT; approve/reject/cancel RPCs bypass RLS as security definer.

-- ---------------------------------------------------------------------------
-- 5) sale_events / audit_events RLS helpers
-- ---------------------------------------------------------------------------
drop policy if exists "read sale events" on public.sale_events;
create policy "read sale events" on public.sale_events for select to authenticated
using (
  branch_id = public.current_staff_branch()
  or public.is_manager()
);

drop policy if exists "insert sale events" on public.sale_events;
create policy "insert sale events" on public.sale_events for insert to authenticated
with check (
  branch_id = public.current_staff_branch()
  or public.is_manager()
);

drop policy if exists "read audit events" on public.audit_events;
create policy "read audit events" on public.audit_events for select to authenticated
using (
  public.is_manager()
  or staff_id = (select id from public.staff where auth_user_id = auth.uid() and is_active limit 1)
);

-- ---------------------------------------------------------------------------
-- 6) Ensure legacy petty_cash is gone (rename migration should have handled this)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.petty_cash') is not null
     and to_regclass('public.cash_drawer_entries') is not null then
    raise exception
      'Both petty_cash and cash_drawer_entries exist — run migrate_rename_petty_cash_to_cash_drawer_entries.sql first';
  end if;
  if to_regclass('public.petty_cash') is not null
     and to_regclass('public.cash_drawer_entries') is null then
    alter table public.petty_cash rename to cash_drawer_entries;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 7) TIN: stop treating branches.tin as writable source of truth
--    (columns kept nullable for one release as read fallback; app stops writing)
-- ---------------------------------------------------------------------------
comment on column public.branches.tin is
  'LEGACY fallback only. Prefer company_profile.tin + branches.branch_tin_code. App no longer writes this.';
comment on column public.branches.business_name is
  'LEGACY fallback only. Prefer company_profile.business_name. App no longer writes this.';
