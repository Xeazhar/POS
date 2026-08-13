-- Harden SECURITY DEFINER RPCs that are granted to authenticated clients.
--
-- WHY: definer functions bypass RLS. Each client-callable RPC must enforce its own scope.
-- This migration adds checks to session, audit, price-history, and promo-expire RPCs that
-- the static audit (audit_security.sql §4) flagged as missing auth patterns.
--
-- Apply any time after migrate_staff_active_session.sql, migrate_bir_pos_compliance.sql,
-- migrate_offline_supervisor_pin.sql, migrate_price_change_history.sql, and
-- migrate_schema_cleanup_v1.sql. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Internal helper — not granted to clients
-- ---------------------------------------------------------------------------
create or replace function public.assert_audit_log_caller(
  p_branch_id uuid,
  p_staff_id uuid,
  p_meta jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := public.current_staff_id();
begin
  if v_actor is null then
    raise exception 'Not authenticated as staff';
  end if;

  if public.is_manager() then
    return;
  end if;

  if p_branch_id is not null and p_branch_id is distinct from public.current_staff_branch() then
    raise exception 'Not authorized';
  end if;

  if p_staff_id is not null and p_staff_id is distinct from v_actor then
    if p_staff_id::text <> coalesce(p_meta->>'approved_by', '')
       and p_staff_id::text <> coalesce(p_meta->>'requested_by', '') then
      raise exception 'Not authorized';
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Session RPCs — only the signed-in staff member may touch their own session row
-- ---------------------------------------------------------------------------
create or replace function public.claim_staff_session(p_staff_id uuid, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_heartbeat timestamptz;
  v_stale interval := interval '15 minutes';
begin
  if p_staff_id is distinct from public.current_staff_id() then
    raise exception 'Not authorized';
  end if;

  if p_staff_id is null or p_session_id is null then
    raise exception 'Session claim requires staff and session id';
  end if;

  select active_session_id, session_heartbeat_at
    into v_existing, v_heartbeat
  from staff
  where id = p_staff_id
  for update;

  if not found then
    raise exception 'Staff not found';
  end if;

  if v_existing is not distinct from p_session_id then
    update staff
    set session_heartbeat_at = now()
    where id = p_staff_id;
    return true;
  end if;

  if v_existing is not null
     and v_heartbeat is not null
     and v_heartbeat > now() - v_stale then
    raise exception 'Already signed in on another device. Sign out there first.';
  end if;

  update staff
  set active_session_id = p_session_id,
      session_heartbeat_at = now()
  where id = p_staff_id;

  return true;
end;
$$;

create or replace function public.heartbeat_staff_session(p_staff_id uuid, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_staff_id is distinct from public.current_staff_id() then
    raise exception 'Not authorized';
  end if;

  update staff
  set session_heartbeat_at = now()
  where id = p_staff_id
    and active_session_id = p_session_id;

  if not found then
    raise exception 'Session is no longer active';
  end if;
  return true;
end;
$$;

create or replace function public.release_staff_session(p_staff_id uuid, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_staff_id is distinct from public.current_staff_id() then
    raise exception 'Not authorized';
  end if;

  update staff
  set active_session_id = null,
      session_heartbeat_at = null
  where id = p_staff_id
    and (active_session_id = p_session_id or active_session_id is null);
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit RPCs — branch + staff attribution must match caller (managers exempt)
-- ---------------------------------------------------------------------------
create or replace function public.log_audit_event(
  p_branch_id uuid,
  p_staff_id uuid,
  p_event_type text,
  p_detail text default null,
  p_meta jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.assert_audit_log_caller(p_branch_id, p_staff_id, coalesce(p_meta, '{}'::jsonb));

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (p_branch_id, p_staff_id, p_event_type, p_detail, coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.log_audit_event_idempotent(
  p_branch_id uuid,
  p_staff_id uuid,
  p_event_type text,
  p_detail text default null,
  p_meta jsonb default '{}'::jsonb,
  p_client_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_meta jsonb;
begin
  v_meta := coalesce(p_meta, '{}'::jsonb);
  perform public.assert_audit_log_caller(p_branch_id, p_staff_id, v_meta);

  if p_client_id is not null and length(trim(p_client_id)) > 0 then
    select ae.id into v_id
    from public.audit_events ae
    where ae.meta->>'offline_client_id' = trim(p_client_id)
    limit 1;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  if p_client_id is not null and length(trim(p_client_id)) > 0 then
    v_meta := v_meta || jsonb_build_object('offline_client_id', trim(p_client_id));
  end if;

  insert into public.audit_events (branch_id, staff_id, event_type, detail, meta)
  values (p_branch_id, p_staff_id, p_event_type, p_detail, v_meta)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Price history — supervisor+ on own branch, managers cross-branch
-- ---------------------------------------------------------------------------
create or replace function public.record_price_change(
  p_branch_id uuid,
  p_product_id uuid,
  p_staff_id uuid,
  p_old_price numeric,
  p_new_price numeric,
  p_detail text default null
)
returns public.stock_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stock numeric;
  v_movement public.stock_movements;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'Not authorized';
  end if;

  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized';
  end if;

  if p_staff_id is not null
     and p_staff_id is distinct from public.current_staff_id()
     and not public.is_manager() then
    raise exception 'Not authorized';
  end if;

  if p_old_price is not distinct from p_new_price then
    return null;
  end if;

  select quantity_on_hand into v_stock
  from branch_inventory
  where branch_id = p_branch_id and product_id = p_product_id;

  v_stock := coalesce(v_stock, 0);

  insert into stock_movements (
    branch_id, product_id, staff_id, movement_type, reference, detail,
    quantity_in, quantity_out, quantity_on_hand_after, old_price, new_price
  ) values (
    p_branch_id, p_product_id, coalesce(p_staff_id, public.current_staff_id()), 'price_change', 'price',
    coalesce(p_detail, 'Price update'),
    0, 0, v_stock, p_old_price, p_new_price
  )
  returning * into v_movement;

  return v_movement;
end;
$$;

-- ---------------------------------------------------------------------------
-- Promo expire sweep — manager screens only (global housekeeping)
-- ---------------------------------------------------------------------------
create or replace function public.expire_ended_promos()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_manager() then
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
