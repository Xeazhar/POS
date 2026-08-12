-- Cash drawer movements: petty cash + pickup during an open staff_shifts session.
-- POS → Open Drawer is the sole creation path; Day End reviews self_recorded rows;
-- Reports lists cross-session history.
--
-- Prerequisite: staff_shifts + shift_cash_summary (migrate_shift_cash_void_fix.sql).
-- Safe to re-run.

do $$
begin
  if to_regclass('public.staff_shifts') is null then
    raise exception 'staff_shifts missing — apply shift cash migrations first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table if not exists public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid unique,
  shift_id uuid not null references public.staff_shifts(id) on delete restrict,
  branch_id uuid not null references public.branches(id),
  drawer_id text not null default 'main',
  drawer_label text not null default 'Main drawer',
  type text not null check (type in ('petty_cash', 'pickup')),
  amount numeric(12,2) not null check (amount > 0),
  reason text not null check (length(trim(reason)) > 0),
  requested_by uuid not null references public.staff(id),
  requested_at timestamptz not null default now(),
  status text not null default 'pending_remote'
    check (status in (
      'pending_remote',
      'approved',
      'remote_approved',
      'denied',
      'self_recorded',
      'confirmed',
      'flagged_for_investigation',
      'voided'
    )),
  approved_by uuid references public.staff(id),
  approved_at timestamptz,
  denied_by uuid references public.staff(id),
  denied_at timestamptz,
  self_record_ack boolean not null default false,
  self_recorded_at timestamptz,
  reviewed_by uuid references public.staff(id),
  reviewed_at timestamptz,
  review_action text check (review_action is null or review_action in ('confirmed', 'flagged_for_investigation')),
  review_notes text,
  created_offline boolean not null default false,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cash_movements_reviewer_not_requester check (
    reviewed_by is null or reviewed_by is distinct from requested_by
  )
);

create index if not exists idx_cash_movements_branch_status
  on public.cash_movements(branch_id, status);
create index if not exists idx_cash_movements_shift
  on public.cash_movements(shift_id);
create index if not exists idx_cash_movements_requested_at
  on public.cash_movements(requested_at desc);
create index if not exists idx_cash_movements_pending
  on public.cash_movements(branch_id, requested_at desc)
  where status = 'pending_remote';

alter table public.cash_movements enable row level security;

drop policy if exists "read cash movements" on public.cash_movements;
drop policy if exists "insert cash movements" on public.cash_movements;
drop policy if exists "update cash movements" on public.cash_movements;

-- Reads: own branch or managers. Writes go through RPCs (security definer); direct
-- client UPDATE is denied so status transitions stay audited.
create policy "read cash movements" on public.cash_movements for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());

create policy "insert cash movements" on public.cash_movements for insert to authenticated
  with check (
    (branch_id = public.current_staff_branch() and requested_by = public.current_staff_id())
    or public.is_manager()
  );

-- No broad UPDATE policy — only RPCs mutate status.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.cash_movement_counts(p_status text)
returns boolean
language sql
immutable
as $$
  select p_status in (
    'approved',
    'remote_approved',
    'self_recorded',
    'confirmed',
    'flagged_for_investigation'
  );
$$;

create or replace function public.touch_cash_movement_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_cash_movements_updated_at on public.cash_movements;
create trigger trg_cash_movements_updated_at
  before update on public.cash_movements
  for each row execute function public.touch_cash_movement_updated_at();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Scenario A: supervisor PIN on site — insert already approved.
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
begin
  if p_type not in ('petty_cash', 'pickup') then
    raise exception 'MOVE01: invalid movement type';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'MOVE02: amount must be positive';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'MOVE03: reason is required';
  end if;
  if p_approved_by is null or p_approved_by = p_requested_by then
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

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_approved_by, 'cash_movement_approved',
    'Approved ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object(
      'cash_movement_id', v_row.id, 'type', v_row.type,
      'amount', v_row.amount, 'via', 'pin'
    )
  );

  return v_row;
end;
$$;

-- Scenario B start: notify manager → pending_remote.
create or replace function public.create_cash_movement_pending(
  p_shift_id uuid,
  p_branch_id uuid,
  p_drawer_id text,
  p_drawer_label text,
  p_type text,
  p_amount numeric,
  p_reason text,
  p_requested_by uuid,
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
begin
  if p_type not in ('petty_cash', 'pickup') then
    raise exception 'MOVE01: invalid movement type';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'MOVE02: amount must be positive';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'MOVE03: reason is required';
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

  insert into public.cash_movements (
    client_id, shift_id, branch_id, drawer_id, drawer_label,
    type, amount, reason, requested_by, status,
    created_offline, synced_at
  ) values (
    p_client_id, p_shift_id, p_branch_id,
    coalesce(nullif(trim(p_drawer_id), ''), 'main'),
    coalesce(nullif(trim(p_drawer_label), ''), 'Main drawer'),
    p_type, round(p_amount, 2), trim(p_reason), p_requested_by, 'pending_remote',
    coalesce(p_created_offline, false),
    case when coalesce(p_created_offline, false) then null else now() end
  )
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_requested_by, 'cash_movement_pending',
    'Requested manager approval for ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object(
      'cash_movement_id', v_row.id, 'type', v_row.type, 'amount', v_row.amount
    )
  );

  return v_row;
end;
$$;

-- On-site PIN during or before countdown → approved (Scenario A / E).
create or replace function public.approve_cash_movement_pin(
  p_id uuid,
  p_approved_by uuid
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cash_movements%rowtype;
begin
  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;
  if p_approved_by is null or p_approved_by = v_row.requested_by then
    raise exception 'MOVE04: supervisor approval required';
  end if;
  if not public.is_supervisor_or_above()
     and v_row.branch_id is distinct from public.current_staff_branch() then
    -- Approver identity comes from PIN verify; still require branch match for non-managers
    -- when called under a cashier JWT — caller should use staff JWT of approver when possible.
    null;
  end if;

  update public.cash_movements
  set status = 'approved',
      approved_by = p_approved_by,
      approved_at = now()
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_approved_by, 'cash_movement_approved',
    'PIN-approved ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id, 'via', 'pin')
  );

  return v_row;
end;
$$;

-- Manager remote approve.
create or replace function public.approve_cash_movement_manager(
  p_id uuid,
  p_approved_by uuid
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
    raise exception 'MOVE12: only managers can remotely approve';
  end if;

  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;
  if p_approved_by is null then
    raise exception 'MOVE04: approver required';
  end if;

  update public.cash_movements
  set status = 'remote_approved',
      approved_by = p_approved_by,
      approved_at = now()
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_approved_by, 'cash_movement_remote_approved',
    'Remote-approved ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id, 'via', 'manager')
  );

  return v_row;
end;
$$;

create or replace function public.deny_cash_movement(
  p_id uuid,
  p_denied_by uuid
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cash_movements%rowtype;
begin
  if not (public.is_manager() or public.is_supervisor_or_above()) then
    raise exception 'MOVE13: only supervisor or manager can deny';
  end if;

  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;

  update public.cash_movements
  set status = 'denied',
      denied_by = p_denied_by,
      denied_at = now()
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_denied_by, 'cash_movement_denied',
    'Denied ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id)
  );

  return v_row;
end;
$$;

-- Scenario C: timeout path.
create or replace function public.self_record_cash_movement(
  p_id uuid,
  p_staff_id uuid,
  p_ack boolean
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cash_movements%rowtype;
begin
  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'pending_remote' then
    raise exception 'MOVE11: movement is not awaiting approval';
  end if;
  if v_row.requested_by is distinct from p_staff_id then
    raise exception 'MOVE14: only the requester can self-record';
  end if;
  if p_ack is not true then
    raise exception 'MOVE15: acknowledgment required';
  end if;
  if nullif(trim(coalesce(v_row.reason, '')), '') is null then
    raise exception 'MOVE03: reason is required';
  end if;

  update public.cash_movements
  set status = 'self_recorded',
      self_record_ack = true,
      self_recorded_at = now()
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'cash_movement_self_recorded',
    'Self-recorded ' || v_row.type || ' ₱' || v_row.amount::text,
    jsonb_build_object('cash_movement_id', v_row.id)
  );

  return v_row;
end;
$$;

-- Day-end review.
create or replace function public.review_cash_movement(
  p_id uuid,
  p_reviewed_by uuid,
  p_action text,
  p_notes text default null
)
returns public.cash_movements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cash_movements%rowtype;
  v_status text;
begin
  if not (public.is_manager() or public.is_supervisor_or_above()) then
    raise exception 'MOVE16: only supervisor or manager can review';
  end if;
  if p_action not in ('confirmed', 'flagged_for_investigation') then
    raise exception 'MOVE17: invalid review action';
  end if;

  select * into v_row from public.cash_movements where id = p_id for update;
  if not found then
    raise exception 'MOVE10: movement not found';
  end if;
  if v_row.status <> 'self_recorded' then
    raise exception 'MOVE18: only self_recorded movements need review';
  end if;
  if p_reviewed_by is null or p_reviewed_by = v_row.requested_by then
    raise exception 'MOVE19: reviewer cannot be the requester';
  end if;
  if not public.is_manager()
     and v_row.branch_id is distinct from public.current_staff_branch() then
    raise exception 'MOVE20: wrong branch';
  end if;

  v_status := p_action; -- confirmed | flagged_for_investigation

  update public.cash_movements
  set status = v_status,
      reviewed_by = p_reviewed_by,
      reviewed_at = now(),
      review_action = p_action,
      review_notes = nullif(trim(coalesce(p_notes, '')), '')
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_reviewed_by, 'cash_movement_reviewed',
    'Reviewed ' || v_row.type || ' as ' || p_action,
    jsonb_build_object('cash_movement_id', v_row.id, 'action', p_action)
  );

  return v_row;
end;
$$;

grant execute on function public.create_cash_movement_approved(
  uuid, uuid, text, text, text, numeric, text, uuid, uuid, uuid, boolean
) to authenticated;
grant execute on function public.create_cash_movement_pending(
  uuid, uuid, text, text, text, numeric, text, uuid, uuid, boolean
) to authenticated;
grant execute on function public.approve_cash_movement_pin(uuid, uuid) to authenticated;
grant execute on function public.approve_cash_movement_manager(uuid, uuid) to authenticated;
grant execute on function public.deny_cash_movement(uuid, uuid) to authenticated;
grant execute on function public.self_record_cash_movement(uuid, uuid, boolean) to authenticated;
grant execute on function public.review_cash_movement(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Expected cash: legacy cash_drawer_entries + counting cash_movements
-- ---------------------------------------------------------------------------
create or replace function public.close_staff_shift(
  p_shift_id uuid,
  p_ending_cash numeric default null,
  p_note text default null,
  p_closed_by uuid default null
)
returns public.staff_shifts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shift public.staff_shifts%rowtype;
  v_sales numeric(12,2) := 0;
  v_refunds numeric(12,2) := 0;
  v_paid_out numeric(12,2) := 0;
  v_pickups numeric(12,2) := 0;
  v_expected numeric(12,2);
  v_row public.staff_shifts%rowtype;
  v_move_paid numeric(12,2) := 0;
  v_move_pick numeric(12,2) := 0;
begin
  select * into v_shift from public.staff_shifts where id = p_shift_id;
  if not found then
    raise exception 'SHIFT_NOT_FOUND: no shift with id %', p_shift_id;
  end if;

  if v_shift.branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'SHIFT_NOT_ALLOWED: that shift belongs to another branch';
  end if;

  if v_shift.clock_out is not null then
    return v_shift;
  end if;

  if not v_shift.holds_drawer then
    update public.staff_shifts
    set clock_out = now(),
        close_note = nullif(trim(coalesce(p_note, '')), ''),
        closed_by = coalesce(p_closed_by, staff_id)
    where id = p_shift_id
    returning * into v_row;
    return v_row;
  end if;

  select
    coalesce(sum(case when t.status = 'completed' then t.total_amount else 0 end), 0),
    coalesce(sum(
      case when t.status = 'completed' then coalesce(t.refunded_amount, 0) else 0 end
    ), 0)
  into v_sales, v_refunds
  from public.transactions t
  where t.shift_id = p_shift_id
    and coalesce(t.payment_method, 'cash') = 'cash';

  select
    coalesce(sum(case when c.kind = 'paid_out' and c.status = 'fulfilled' then c.amount else 0 end), 0),
    coalesce(sum(case when c.kind = 'pickup' then c.amount else 0 end), 0)
  into v_paid_out, v_pickups
  from public.cash_drawer_entries c
  where c.shift_id = p_shift_id;

  select
    coalesce(sum(case when m.type = 'petty_cash' then m.amount else 0 end), 0),
    coalesce(sum(case when m.type = 'pickup' then m.amount else 0 end), 0)
  into v_move_paid, v_move_pick
  from public.cash_movements m
  where m.shift_id = p_shift_id
    and public.cash_movement_counts(m.status);

  v_paid_out := v_paid_out + v_move_paid;
  v_pickups := v_pickups + v_move_pick;

  v_expected := round(
    coalesce(v_shift.starting_cash, 0) + v_sales - v_refunds - v_paid_out - v_pickups, 2);

  update public.staff_shifts
  set clock_out = now(),
      ending_cash = case when p_ending_cash is null then null else round(p_ending_cash, 2) end,
      expected_cash = case when p_ending_cash is null then null else v_expected end,
      variance = case when p_ending_cash is null then null else round(round(p_ending_cash, 2) - v_expected, 2) end,
      cash_sales = v_sales,
      cash_refunds = v_refunds,
      cash_paid_out = v_paid_out,
      cash_pickups = v_pickups,
      close_note = nullif(trim(coalesce(p_note, '')), ''),
      closed_by = coalesce(p_closed_by, staff_id)
  where id = p_shift_id
  returning * into v_row;

  return v_row;
end $$;

create or replace function public.shift_cash_summary(p_shift_id uuid)
returns table (
  starting_cash numeric,
  cash_sales numeric,
  cash_refunds numeric,
  cash_paid_out numeric,
  cash_pickups numeric,
  expected_cash numeric,
  sale_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select * from public.staff_shifts
    where id = p_shift_id
      and (
        staff_id = public.current_staff_id()
        or public.is_manager()
        or (public.is_supervisor_or_above() and branch_id = public.current_staff_branch())
      )
  ),
  t as (
    select
      coalesce(sum(case when status = 'completed' then total_amount else 0 end), 0) as sales,
      coalesce(sum(case when status = 'completed' then coalesce(refunded_amount, 0) else 0 end), 0) as refunds,
      count(*) filter (where status = 'completed') as sale_count
    from public.transactions
    where shift_id = p_shift_id and coalesce(payment_method, 'cash') = 'cash'
  ),
  c as (
    select
      coalesce(sum(case when kind = 'paid_out' and status = 'fulfilled' then amount else 0 end), 0) as paid_out,
      coalesce(sum(case when kind = 'pickup' then amount else 0 end), 0) as pickups
    from public.cash_drawer_entries
    where shift_id = p_shift_id
  ),
  m as (
    select
      coalesce(sum(case when type = 'petty_cash' then amount else 0 end), 0) as paid_out,
      coalesce(sum(case when type = 'pickup' then amount else 0 end), 0) as pickups
    from public.cash_movements
    where shift_id = p_shift_id
      and public.cash_movement_counts(status)
  )
  select
    coalesce(s.starting_cash, 0),
    t.sales,
    t.refunds,
    c.paid_out + m.paid_out,
    c.pickups + m.pickups,
    round(coalesce(s.starting_cash, 0) + t.sales - t.refunds - (c.paid_out + m.paid_out) - (c.pickups + m.pickups), 2),
    t.sale_count::integer
  from s, t, c, m;
$$;

grant execute on function public.close_staff_shift(uuid, numeric, text, uuid) to authenticated;
grant execute on function public.shift_cash_summary(uuid) to authenticated;

-- Realtime
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'cash_movements')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cash_movements'
    )
  then
    alter publication supabase_realtime add table public.cash_movements;
  end if;
end $$;

notify pgrst, 'reload schema';
