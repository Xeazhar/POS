-- BIR / fiscal POS readiness for CalePOS
-- Sequential OR numbering, immutable sales, void logs, audit trail, branch identity fields.
-- Apply in Supabase SQL editor after base schema + prior migrations.
-- NOTE: This prepares operational controls for BIR review. Formal accreditation
-- still requires BIR-approved POS certification processes outside this app.

-- ---------------------------------------------------------------------------
-- 1) Branch fiscal identity + OR sequence
-- ---------------------------------------------------------------------------
alter table branches
  add column if not exists business_name text,
  add column if not exists tin text,
  add column if not exists bir_permit_no text,
  add column if not exists machine_identification_no text,
  add column if not exists serial_number text,
  add column if not exists or_prefix text not null default 'OR',
  add column if not exists or_next bigint not null default 1 check (or_next >= 1);

update branches
set business_name = coalesce(nullif(business_name, ''), name)
where business_name is null or business_name = '';

-- ---------------------------------------------------------------------------
-- 2) Transaction OR number + void metadata (non-editable financial core)
-- ---------------------------------------------------------------------------
alter table transactions
  add column if not exists or_number text,
  add column if not exists client_id text,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references staff(id) on delete set null;

create unique index if not exists uq_transactions_branch_or
  on transactions (branch_id, or_number)
  where or_number is not null;

create unique index if not exists uq_transactions_branch_client
  on transactions (branch_id, client_id)
  where client_id is not null;

-- Backfill sequential OR for existing rows missing or_number
with numbered as (
  select
    t.id,
    row_number() over (partition by t.branch_id order by t.created_at, t.id) as rn,
    coalesce(nullif(b.or_prefix, ''), 'OR') as prefix
  from transactions t
  join branches b on b.id = t.branch_id
  where t.or_number is null
)
update transactions t
set or_number = n.prefix || '-' || lpad(n.rn::text, 8, '0')
from numbered n
where t.id = n.id;

update branches b
set or_next = greatest(
  b.or_next,
  coalesce((
    select max(nullif(regexp_replace(t.or_number, '^.*[^0-9]', '', 'g'), '')::bigint)
    from transactions t
    where t.branch_id = b.id and t.or_number is not null
  ), 0) + 1
);

-- ---------------------------------------------------------------------------
-- 3) Append-only sale / void / refund event log
-- ---------------------------------------------------------------------------
create table if not exists sale_events (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  transaction_id uuid references transactions(id) on delete set null,
  staff_id uuid references staff(id) on delete set null,
  event_type text not null check (event_type in ('sale', 'void', 'refund', 'reprint')),
  or_number text,
  reason text,
  amount numeric(10,2),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_sale_events_branch_created on sale_events(branch_id, created_at desc);
create index if not exists idx_sale_events_txn on sale_events(transaction_id);

alter table sale_events enable row level security;

drop policy if exists "read sale events" on sale_events;
create policy "read sale events" on sale_events for select to authenticated
using (
  branch_id in (select branch_id from staff where auth_user_id = auth.uid())
  or exists (select 1 from staff where auth_user_id = auth.uid() and role in ('manager', 'admin'))
);

drop policy if exists "insert sale events" on sale_events;
create policy "insert sale events" on sale_events for insert to authenticated
with check (
  branch_id in (select branch_id from staff where auth_user_id = auth.uid())
  or exists (select 1 from staff where auth_user_id = auth.uid() and role in ('manager', 'admin'))
);

-- No UPDATE/DELETE policies → immutable log under RLS

-- ---------------------------------------------------------------------------
-- 4) Staff login / logout audit trail
-- ---------------------------------------------------------------------------
create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references branches(id) on delete set null,
  staff_id uuid references staff(id) on delete set null,
  event_type text not null,
  detail text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_events_created on audit_events(created_at desc);
create index if not exists idx_audit_events_staff on audit_events(staff_id, created_at desc);

alter table audit_events enable row level security;

drop policy if exists "read audit events" on audit_events;
create policy "read audit events" on audit_events for select to authenticated
using (
  exists (select 1 from staff where auth_user_id = auth.uid() and role in ('manager', 'admin'))
  or staff_id in (select id from staff where auth_user_id = auth.uid())
);

drop policy if exists "insert audit events" on audit_events;
create policy "insert audit events" on audit_events for insert to authenticated
with check (true);

-- ---------------------------------------------------------------------------
-- 5) Immutability: sales lines never change; transactions only void fields
-- ---------------------------------------------------------------------------
create or replace function prevent_transaction_item_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'transaction_items are immutable (BIR non-editable sales records)';
end;
$$;

drop trigger if exists trg_no_update_transaction_items on transaction_items;
create trigger trg_no_update_transaction_items
before update or delete on transaction_items
for each row execute function prevent_transaction_item_mutation();

create or replace function guard_transaction_updates()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'transactions cannot be deleted';
  end if;

  -- Allow only void-related transitions / metadata
  if old.status = 'voided' then
    raise exception 'voided transactions are locked';
  end if;

  if new.branch_id is distinct from old.branch_id
     or new.total_amount is distinct from old.total_amount
     or new.amount_tendered is distinct from old.amount_tendered
     or new.change_given is distinct from old.change_given
     or new.or_number is distinct from old.or_number
     or new.created_at is distinct from old.created_at
     or new.staff_id is distinct from old.staff_id
     or new.client_id is distinct from old.client_id then
    raise exception 'sale financial fields are immutable';
  end if;

  if new.status = 'voided' and old.status = 'completed' then
    new.voided_at := coalesce(new.voided_at, now());
    return new;
  end if;

  raise exception 'transactions are immutable except for voiding a completed sale';
end;
$$;

drop trigger if exists trg_guard_transaction_updates on transactions;
create trigger trg_guard_transaction_updates
before update or delete on transactions
for each row execute function guard_transaction_updates();

-- ---------------------------------------------------------------------------
-- 6) Allocate next OR under branch row lock
-- ---------------------------------------------------------------------------
create or replace function allocate_or_number(p_branch_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text;
  v_next bigint;
  v_or text;
begin
  select or_prefix, or_next
  into v_prefix, v_next
  from branches
  where id = p_branch_id
  for update;

  if not found then
    raise exception 'Branch not found';
  end if;

  v_or := coalesce(nullif(v_prefix, ''), 'OR') || '-' || lpad(v_next::text, 8, '0');
  update branches set or_next = v_next + 1 where id = p_branch_id;
  return v_or;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Secure void RPC (restores stock + append-only void log)
-- ---------------------------------------------------------------------------
create or replace function void_sale_secure(
  p_transaction_id uuid,
  p_staff_id uuid,
  p_reason text
)
returns transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn transactions;
  v_line record;
begin
  select * into v_txn from transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'Transaction not found';
  end if;
  if v_txn.status = 'voided' then
    raise exception 'Transaction already voided';
  end if;

  update transactions
  set
    status = 'voided',
    void_reason = coalesce(nullif(trim(p_reason), ''), 'Voided'),
    voided_at = now(),
    voided_by = p_staff_id
  where id = p_transaction_id
  returning * into v_txn;

  -- Restock inventory for each line
  for v_line in
    select product_id, quantity from transaction_items where transaction_id = p_transaction_id
  loop
    perform record_stock_movement(
      v_txn.branch_id,
      v_line.product_id,
      p_staff_id,
      'restock',
      v_line.quantity,
      0,
      v_txn.id::text,
      'Void restock ' || coalesce(v_txn.or_number, v_txn.id::text)
    );
  end loop;

  insert into sale_events (branch_id, transaction_id, staff_id, event_type, or_number, reason, amount, payload)
  values (
    v_txn.branch_id,
    v_txn.id,
    p_staff_id,
    'void',
    v_txn.or_number,
    v_txn.void_reason,
    v_txn.total_amount,
    jsonb_build_object('voided_at', v_txn.voided_at)
  );

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_txn.branch_id,
    p_staff_id,
    'sale_void',
    'Voided ' || coalesce(v_txn.or_number, v_txn.id::text),
    jsonb_build_object('transaction_id', v_txn.id, 'reason', v_txn.void_reason)
  );

  return v_txn;
end;
$$;

grant execute on function allocate_or_number(uuid) to authenticated;
grant execute on function void_sale_secure(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Helper: log audit from client
-- ---------------------------------------------------------------------------
create or replace function log_audit_event(
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
  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (p_branch_id, p_staff_id, p_event_type, p_detail, coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function log_audit_event(uuid, uuid, text, text, jsonb) to authenticated;
