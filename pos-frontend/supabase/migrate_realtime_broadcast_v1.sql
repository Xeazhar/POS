-- Private Realtime Broadcast for branch-scoped POS events.
-- Apply after migrate_enable_realtime.sql (postgres_changes publication can remain
-- as a secondary path for promo tables; inventory/ops prefer Broadcast).
--
-- Topics (private):
--   pos:branch:<branch_uuid>:inventory
--   pos:branch:<branch_uuid>:operations
--   pos:network:operations          (managers only — cross-branch inbox)
--
-- Payloads are minimal (event + branch_id + ids/version/kind). Never include
-- stock quantities, PINs, passwords, customer PII, or full row snapshots.
--
-- Dashboard prerequisite (manual): Realtime → enable Authorization / private
-- channels for the project. Without that, private subscriptions fail closed.
--
-- Do NOT `ALTER TABLE realtime.messages` — that table is owned by Supabase
-- internals (ERROR 42501 must be owner). RLS is already enabled there; this
-- migration only CREATE POLICYs. If policy creation is also denied, run the
-- policy block from `migrate_realtime_broadcast_policies.sql` via a role that
-- can manage realtime, or add the same policies in the Dashboard.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Monotonic version on inventory rows (gap detection on clients)
-- ---------------------------------------------------------------------------
alter table public.branch_inventory
  add column if not exists change_version bigint not null default 0;

-- ---------------------------------------------------------------------------
-- 2) Branch subscribe helper (Auth identity → staff row; never trust client)
-- ---------------------------------------------------------------------------
create or replace function public.staff_can_subscribe_branch(p_branch_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_branch_id is not null
    and (
      p_branch_id = public.current_staff_branch()
      or public.is_manager()
    );
$$;

revoke all on function public.staff_can_subscribe_branch(uuid) from public;
grant execute on function public.staff_can_subscribe_branch(uuid) to authenticated;

create or replace function public.realtime_pos_topic_branch_id()
returns uuid
language sql
stable
as $$
  select (
    regexp_match(
      coalesce(realtime.topic(), ''),
      '^pos:branch:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(inventory|operations)$'
    )
  )[1]::uuid;
$$;

create or replace function public.realtime_pos_is_network_ops()
returns boolean
language sql
stable
as $$
  select coalesce(realtime.topic(), '') = 'pos:network:operations';
$$;

-- ---------------------------------------------------------------------------
-- 3) realtime.messages policies — receive only; no client send (no INSERT policy)
--    Skips ALTER TABLE (not allowed). Continues migration even if CREATE POLICY
--    is denied — re-run migrate_realtime_broadcast_policies.sql if needed.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'realtime.messages missing — skip Realtime Authorization policies';
    return;
  end if;

  begin
    execute 'drop policy if exists "pos branch broadcast receive" on realtime.messages';
  exception
    when insufficient_privilege then
      raise notice 'Cannot DROP policy on realtime.messages (not owner) — skip; see migrate_realtime_broadcast_policies.sql';
      return;
    when undefined_object then
      null;
    when others then
      -- 42501 often reported as insufficient_privilege; catch ownership errors too
      if SQLSTATE = '42501' then
        raise notice 'Cannot manage policies on realtime.messages (%) — skip; see migrate_realtime_broadcast_policies.sql', SQLERRM;
        return;
      end if;
      raise;
  end;

  begin
    execute $pol$
      create policy "pos branch broadcast receive"
      on realtime.messages
      for select
      to authenticated
      using (
        coalesce(realtime.messages.extension, '') = 'broadcast'
        and (
          (
            public.realtime_pos_topic_branch_id() is not null
            and public.staff_can_subscribe_branch(public.realtime_pos_topic_branch_id())
          )
          or (
            public.realtime_pos_is_network_ops()
            and public.is_manager()
          )
        )
      )
    $pol$;
  exception
    when duplicate_object then
      raise notice 'Policy "pos branch broadcast receive" already exists';
    when insufficient_privilege then
      raise notice 'Cannot CREATE policy on realtime.messages — apply migrate_realtime_broadcast_policies.sql or Dashboard policies';
    when others then
      if SQLSTATE = '42501' then
        raise notice 'Cannot CREATE policy on realtime.messages (%) — apply migrate_realtime_broadcast_policies.sql', SQLERRM;
      else
        raise;
      end if;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 4) Server-side broadcast helper (never fails the business txn)
-- ---------------------------------------------------------------------------
create or replace function public.broadcast_pos_event(
  p_branch_id uuid,
  p_channel text,
  p_event text,
  p_payload jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_topic text;
  v_payload jsonb;
begin
  if p_branch_id is null then
    return;
  end if;
  if p_channel is distinct from 'inventory' and p_channel is distinct from 'operations' then
    raise exception 'broadcast_pos_event: invalid channel %', p_channel;
  end if;
  if p_event is null or length(trim(p_event)) = 0 then
    raise exception 'broadcast_pos_event: event required';
  end if;

  v_topic := format('pos:branch:%s:%s', p_branch_id::text, p_channel);
  v_payload := coalesce(p_payload, '{}'::jsonb)
    || jsonb_build_object(
      'event', p_event,
      'branch_id', p_branch_id
    );
  -- Defence in depth: strip accidental sensitive keys
  v_payload := v_payload
    - 'password' - 'pin' - 'pin_hash' - 'pin_verifier' - 'secret'
    - 'service_role' - 'access_token' - 'refresh_token'
    - 'quantity_on_hand' - 'stock' - 'customer' - 'customer_phone';

  begin
    perform realtime.send(v_payload, p_event, v_topic, true);
  exception when others then
    raise warning 'broadcast_pos_event send failed (%): %', v_topic, SQLERRM;
  end;

  if p_channel = 'operations' then
    begin
      perform realtime.send(v_payload, p_event, 'pos:network:operations', true);
    exception when others then
      raise warning 'broadcast_pos_event network send failed: %', SQLERRM;
    end;
  end if;
end;
$$;

-- Triggers run as definer; clients must NOT call this (fake events / cost abuse).
revoke all on function public.broadcast_pos_event(uuid, text, text, jsonb) from public;
revoke all on function public.broadcast_pos_event(uuid, text, text, jsonb) from authenticated;
revoke all on function public.broadcast_pos_event(uuid, text, text, jsonb) from anon;

-- ---------------------------------------------------------------------------
-- 5) Inventory: bump version + minimal broadcast (no qty in payload)
-- ---------------------------------------------------------------------------
create or replace function public.tg_branch_inventory_bump_version()
returns trigger
language plpgsql
as $$
begin
  new.change_version := coalesce(old.change_version, 0) + 1;
  new.updated_at := coalesce(new.updated_at, now());
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_branch_inventory_bump_version on public.branch_inventory;
create trigger trg_branch_inventory_bump_version
  before update on public.branch_inventory
  for each row
  execute function public.tg_branch_inventory_bump_version();

create or replace function public.tg_branch_inventory_broadcast()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.broadcast_pos_event(
    new.branch_id,
    'inventory',
    'INVENTORY_CHANGED',
    jsonb_build_object(
      'product_id', new.product_id,
      'version', new.change_version
    )
  );
  return null;
end;
$$;

drop trigger if exists trg_branch_inventory_broadcast on public.branch_inventory;
create trigger trg_branch_inventory_broadcast
  after insert or update on public.branch_inventory
  for each row
  execute function public.tg_branch_inventory_broadcast();

-- Catalog / price identity changes — still refetch; no prices in payload
create or replace function public.tg_products_catalog_broadcast()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.price is not distinct from old.price
     and new.name is not distinct from old.name
     and new.is_active is not distinct from old.is_active
     and new.discount_eligible is not distinct from old.discount_eligible
     and new.available_today is not distinct from old.available_today
     and new.budget_price is not distinct from old.budget_price
  then
    return null;
  end if;

  perform public.broadcast_pos_event(
    new.branch_id,
    'inventory',
    'CATALOG_CHANGED',
    jsonb_build_object('product_id', new.id)
  );
  return null;
end;
$$;

drop trigger if exists trg_products_catalog_broadcast on public.products;
create trigger trg_products_catalog_broadcast
  after insert or update on public.products
  for each row
  execute function public.tg_products_catalog_broadcast();

-- ---------------------------------------------------------------------------
-- 6) Operations: day-end, cash, refunds, till actions, shifts
-- ---------------------------------------------------------------------------
create or replace function public.tg_ops_broadcast()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_branch uuid;
begin
  v_branch := coalesce(new.branch_id, old.branch_id);
  if v_branch is null then
    return null;
  end if;
  perform public.broadcast_pos_event(
    v_branch,
    'operations',
    'OPERATIONS_CHANGED',
    jsonb_build_object('kind', tg_table_name, 'op', tg_op)
  );
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'day_ends',
    'cash_movements',
    'cash_drawer_entries',
    'refund_requests',
    'till_action_requests',
    'staff_shifts',
    'promo_events'
  ]
  loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      execute format('drop trigger if exists trg_%s_ops_broadcast on public.%I', t, t);
      execute format(
        'create trigger trg_%s_ops_broadcast after insert or update or delete on public.%I for each row execute function public.tg_ops_broadcast()',
        t, t
      );
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 7) Tighten direct inventory writes: cashiers SELECT only; mutations via RPC
--    or supervisor/manager catalog paths (record_stock_movement is SECURITY DEFINER)
-- ---------------------------------------------------------------------------
drop policy if exists "write inventory" on public.branch_inventory;
drop policy if exists "write inventory privileged" on public.branch_inventory;
create policy "write inventory privileged" on public.branch_inventory
  for all to authenticated
  using (
    public.is_manager()
    or (
      public.is_supervisor_or_above()
      and branch_id = public.current_staff_branch()
    )
  )
  with check (
    public.is_manager()
    or (
      public.is_supervisor_or_above()
      and branch_id = public.current_staff_branch()
    )
  );

-- ---------------------------------------------------------------------------
-- 8) Audit trail: no client UPDATE/DELETE (append-only via insert / RPCs)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.audit_events') is null then
    return;
  end if;
  execute 'drop policy if exists "no update audit events" on public.audit_events';
  execute 'drop policy if exists "no delete audit events" on public.audit_events';
  -- RLS: absence of UPDATE/DELETE policies already denies those commands when
  -- FORCE is off. Explicit policies that always fail document intent.
  execute $p$
    create policy "no update audit events" on public.audit_events
      for update to authenticated
      using (false)
      with check (false)
  $p$;
  execute $p$
    create policy "no delete audit events" on public.audit_events
      for delete to authenticated
      using (false)
  $p$;
end $$;

do $$
begin
  if to_regclass('public.sale_events') is null then
    return;
  end if;
  execute 'drop policy if exists "no update sale events" on public.sale_events';
  execute 'drop policy if exists "no delete sale events" on public.sale_events';
  execute $p$
    create policy "no update sale events" on public.sale_events
      for update to authenticated
      using (false)
      with check (false)
  $p$;
  execute $p$
    create policy "no delete sale events" on public.sale_events
      for delete to authenticated
      using (false)
  $p$;
end $$;
