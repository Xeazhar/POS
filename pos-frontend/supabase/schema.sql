-- =============================================================================
-- CalePOS — canonical schema (new installs)
-- Existing DBs: apply migrate_*.sql patches instead of re-running this whole file.
-- See supabase/README.md for table map + apply order.
--
-- Sections:
--   1. Core org (branches, roles, staff)
--   2. Catalog (categories, products, inventory, movements)
--   3. Sales (transactions, items)
--   4. Promos
--   5. Day-end & imports
--   6. RLS helpers + policies
--   7. Business functions / triggers
--   8. Presence / devices
--   9. PIN lockout (auth hardening)
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Core org
-- ---------------------------------------------------------------------------
create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  is_active boolean not null default true,
  branch_type text not null default 'retail' check (branch_type in ('retail', 'restaurant')),
  day_open_hour integer not null default 7 check (day_open_hour >= 0 and day_open_hour <= 23),
  device_settings jsonb not null default '{"barcode_scanner":false,"receipt_printer":false,"cash_drawer":false}'::jsonb,
  vat_rate numeric(5,4) not null default 0.12,
  created_at timestamptz not null default now()
);

create table if not exists roles (
  name text primary key,
  label text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

insert into roles (name, label, sort_order) values
  ('cashier', 'Cashier', 1),
  ('supervisor', 'Supervisor', 2),
  ('manager', 'Manager', 3),
  ('admin', 'Admin', 4),
  ('master', 'Master', 5)
on conflict (name) do nothing;

create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id) on delete cascade unique,
  branch_id uuid not null references branches(id) on delete restrict,
  full_name text not null,
  role text not null references roles(name) on update cascade on delete restrict,
  is_active boolean not null default true,
  -- Till login (cashiers / supervisors): numeric staff code + complex PIN
  login_code text,
  login_pin text,
  auth_secret text,
  permissions jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_staff_branch on staff(branch_id);
create unique index if not exists idx_staff_login_code_unique
  on staff (login_code)
  where login_code is not null and login_code <> '';

-- ---------------------------------------------------------------------------
-- 2. Catalog
-- ---------------------------------------------------------------------------
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists products (
  -- id = stable UUID for sales lines / Power BI joins (never reuse)
  -- product_no = per-branch sequential code shown as 0001, 0002, …
  -- sku = human business key used for CSV import matching
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  category_id uuid references categories(id) on delete set null,
  name text not null,
  sku text not null,
  barcode text,
  product_no integer,
  pricing_mode text not null check (pricing_mode in ('per_unit', 'per_kg')),
  price numeric(10,2) not null check (price >= 0),
  budget_price numeric(10,2) check (budget_price is null or budget_price >= 0),
  menu_kind text check (menu_kind is null or menu_kind in ('meat', 'veggie', 'pancit', 'drink', 'rice', 'extra')),
  low_stock_threshold numeric(10,2) not null default 10,
  medium_stock_threshold numeric(10,2) not null default 30,
  discount_eligible boolean not null default true,
  is_active boolean not null default true,
  available_today boolean not null default true,
  created_at timestamptz not null default now(),
  unique (branch_id, sku),
  unique (branch_id, barcode)
);
create index if not exists idx_products_branch on products(branch_id);
create index if not exists idx_products_sku on products(branch_id, sku);
create index if not exists idx_products_barcode on products(branch_id, barcode);
create unique index if not exists idx_products_branch_product_no on products(branch_id, product_no);

create table if not exists branch_inventory (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  quantity_on_hand numeric(10,2) not null default 0,
  updated_at timestamptz not null default now(),
  unique (branch_id, product_id)
);

create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  staff_id uuid references staff(id) on delete set null,
  movement_type text not null check (movement_type in ('restock', 'sale', 'adjustment', 'shrinkage', 'update', 'price_change')),
  reference text,
  detail text,
  quantity_in numeric(10,2) not null default 0,
  quantity_out numeric(10,2) not null default 0,
  quantity_on_hand_after numeric(10,2) not null,
  old_price numeric(10,2),
  new_price numeric(10,2),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Sales
-- ---------------------------------------------------------------------------
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete restrict,
  staff_id uuid references staff(id) on delete set null,
  total_amount numeric(10,2) not null check (total_amount >= 0),
  amount_tendered numeric(10,2),
  change_given numeric(10,2),
  status text not null check (status in ('completed', 'voided')) default 'completed',
  void_reason text,
  or_number text,
  client_id text,
  order_type text check (order_type is null or order_type in ('dine_in', 'takeout')),
  ulam_combo text,
  voided_at timestamptz,
  voided_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists transaction_items (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  quantity numeric(10,2) not null check (quantity > 0),
  unit_price numeric(10,2) not null,
  line_total numeric(10,2) not null,
  price_tier text check (price_tier is null or price_tier in ('regular', 'budget')),
  discount_eligible boolean not null default false,
  discount_amount numeric(10,2) not null default 0
);

-- ---------------------------------------------------------------------------
-- 4. Promos
-- ---------------------------------------------------------------------------
create table if not exists promo_events (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  name text not null,
  is_active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists promo_rules (
  id uuid primary key default gen_random_uuid(),
  promo_event_id uuid not null references promo_events(id) on delete cascade,
  rule_type text not null check (rule_type in ('item_pct', 'pair_pct', 'bundle_pct', 'bogo_pct')),
  discount_pct numeric(5,2) not null check (discount_pct >= 0 and discount_pct <= 100),
  buy_qty numeric(10,2) not null default 1 check (buy_qty > 0),
  get_qty numeric(10,2) not null default 1 check (get_qty > 0),
  created_at timestamptz not null default now()
);

create table if not exists promo_rule_products (
  id uuid primary key default gen_random_uuid(),
  promo_rule_id uuid not null references promo_rules(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  product_index integer not null default 0,
  quantity_required numeric(10,2) not null default 1 check (quantity_required > 0)
);

create index if not exists idx_promo_rules_event on promo_rules(promo_event_id);
create index if not exists idx_promo_rule_products_rule on promo_rule_products(promo_rule_id);
create index if not exists idx_promo_events_branch on promo_events(branch_id);

create unique index if not exists uniq_active_promo_event_per_branch
  on promo_events(branch_id)
  where is_active = true;

-- ---------------------------------------------------------------------------
-- 5. Day-end & imports
-- ---------------------------------------------------------------------------
create table if not exists day_ends (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  staff_id uuid references staff(id) on delete set null,
  business_date date not null,
  recorded_cash numeric(10,2) not null default 0,
  cash_on_hand numeric(10,2) not null default 0,
  variance numeric(10,2) not null default 0,
  note text,
  day_report jsonb,
  status text not null default 'closed' check (status in ('submitted', 'closed', 'reopened')),
  closed_at timestamptz not null default now(),
  expected_cash numeric(10,2),
  submitted_at timestamptz,
  submitted_by uuid references staff(id) on delete set null,
  approved_at timestamptz,
  approved_by uuid references staff(id) on delete set null,
  reopened_at timestamptz,
  reopened_by uuid references staff(id) on delete set null,
  reopen_reason text,
  unique (branch_id, business_date)
);

create table if not exists import_batches (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  staff_id uuid references staff(id) on delete set null,
  filename text not null,
  file_hash text not null,
  row_count integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  status text not null default 'committed' check (status in ('committed', 'reverted')),
  created_at timestamptz not null default now(),
  reverted_at timestamptz,
  reverted_by uuid references staff(id) on delete set null
);
create index if not exists idx_import_batches_branch_hash
  on import_batches(branch_id, file_hash, created_at desc);
create index if not exists idx_import_batches_branch_created
  on import_batches(branch_id, created_at desc);

create table if not exists import_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references import_batches(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  action text not null check (action in ('create', 'restock')),
  quantity_added numeric(10,2) not null default 0,
  name text,
  sku text,
  barcode text
);
create index if not exists idx_import_batch_items_batch on import_batch_items(batch_id);

-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------
alter table branches enable row level security;
alter table staff enable row level security;
alter table roles enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table branch_inventory enable row level security;
alter table stock_movements enable row level security;
alter table transactions enable row level security;
alter table transaction_items enable row level security;
alter table promo_events enable row level security;
alter table promo_rules enable row level security;
alter table promo_rule_products enable row level security;
alter table day_ends enable row level security;
alter table import_batches enable row level security;
alter table import_batch_items enable row level security;

-- ---------------------------------------------------------------------------
-- 7. RLS helpers + policies
-- ---------------------------------------------------------------------------
create or replace function public.current_staff_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.staff where auth_user_id = auth.uid() and is_active = true limit 1;
$$;

create or replace function public.current_staff_branch() returns uuid
language sql stable security definer set search_path = public as $$
  select branch_id from public.staff where auth_user_id = auth.uid() and is_active = true limit 1;
$$;

create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_staff_role() in ('manager', 'admin', 'master'), false);
$$;

drop policy if exists "staff reads own branch" on branches;
drop policy if exists "managers read all branches" on branches;
drop policy if exists "managers write branches" on branches;
drop policy if exists "read branches" on branches;
create policy "read branches" on branches for select to authenticated
  using (id = public.current_staff_branch() or public.is_manager());
drop policy if exists "managers write branches" on branches;
create policy "managers write branches" on branches for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "staff reads own profile" on staff;
drop policy if exists "managers manage staff" on staff;
drop policy if exists "read staff" on staff;
create policy "read staff" on staff for select to authenticated
  using (auth_user_id = auth.uid() or public.is_manager());
drop policy if exists "managers manage staff" on staff;
create policy "managers manage staff" on staff for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "read roles" on roles;
create policy "read roles" on roles for select to authenticated using (true);
drop policy if exists "managers write roles" on roles;
create policy "managers write roles" on roles for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "staff reads categories" on categories;
drop policy if exists "read categories" on categories;
create policy "read categories" on categories for select to authenticated using (true);
drop policy if exists "managers write categories" on categories;
create policy "managers write categories" on categories for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "staff reads products" on products;
drop policy if exists "managers write products" on products;
drop policy if exists "read products" on products;
drop policy if exists "write products" on products;
create policy "read products" on products for select to authenticated
  using (
    (branch_id = public.current_staff_branch() and is_active = true)
    or public.is_manager()
  );
create policy "write products" on products for all to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

drop policy if exists "staff sees own branch inventory" on branch_inventory;
drop policy if exists "managers adjust own branch inventory" on branch_inventory;
drop policy if exists "read inventory" on branch_inventory;
drop policy if exists "write inventory" on branch_inventory;
create policy "read inventory" on branch_inventory for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());
create policy "write inventory" on branch_inventory for all to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

drop policy if exists "staff sees own branch movements" on stock_movements;
drop policy if exists "staff creates own branch movements" on stock_movements;
drop policy if exists "read movements" on stock_movements;
drop policy if exists "write movements" on stock_movements;
create policy "read movements" on stock_movements for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());
create policy "write movements" on stock_movements for insert to authenticated
  with check (branch_id = public.current_staff_branch() or public.is_manager());

drop policy if exists "staff sees own branch transactions" on transactions;
drop policy if exists "staff creates own branch transactions" on transactions;
drop policy if exists "managers void own branch transactions" on transactions;
drop policy if exists "read transactions" on transactions;
drop policy if exists "write transactions" on transactions;
drop policy if exists "update transactions" on transactions;
create policy "read transactions" on transactions for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());
create policy "write transactions" on transactions for insert to authenticated
  with check (branch_id = public.current_staff_branch() or public.is_manager());
create policy "update transactions" on transactions for update to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

drop policy if exists "staff sees transaction items" on transaction_items;
drop policy if exists "staff creates transaction items" on transaction_items;
drop policy if exists "read txn items" on transaction_items;
drop policy if exists "write txn items" on transaction_items;
create policy "read txn items" on transaction_items for select to authenticated
  using (exists (
    select 1 from transactions t
    where t.id = transaction_id and (t.branch_id = public.current_staff_branch() or public.is_manager())
  ));
create policy "write txn items" on transaction_items for insert to authenticated
  with check (exists (
    select 1 from transactions t
    where t.id = transaction_id and (t.branch_id = public.current_staff_branch() or public.is_manager())
  ));

-- Promo system RLS
drop policy if exists "branch staff reads promo events" on promo_events;
drop policy if exists "managers manage promo events" on promo_events;
drop policy if exists "branch staff reads promo rules" on promo_rules;
drop policy if exists "managers manage promo rules" on promo_rules;
drop policy if exists "branch staff reads promo rule products" on promo_rule_products;
drop policy if exists "managers manage promo rule products" on promo_rule_products;

create policy "branch staff reads promo events" on promo_events for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());

-- Managers: all branches. Supervisors: own branch only.
create policy "managers manage promo events" on promo_events for all to authenticated
  using (
    public.is_manager()
    or (public.current_staff_role() = 'supervisor' and branch_id = public.current_staff_branch())
  )
  with check (
    public.is_manager()
    or (public.current_staff_role() = 'supervisor' and branch_id = public.current_staff_branch())
  );

create policy "branch staff reads promo rules" on promo_rules for select to authenticated
  using (
    exists (
      select 1 from promo_events e
      where e.id = promo_rules.promo_event_id
        and (e.branch_id = public.current_staff_branch() or public.is_manager())
    )
  );

create policy "managers manage promo rules" on promo_rules for all to authenticated
  using (
    exists (
      select 1 from promo_events e
      where e.id = promo_rules.promo_event_id
        and (
          public.is_manager()
          or (public.current_staff_role() = 'supervisor' and e.branch_id = public.current_staff_branch())
        )
    )
  )
  with check (
    exists (
      select 1 from promo_events e
      where e.id = promo_rules.promo_event_id
        and (
          public.is_manager()
          or (public.current_staff_role() = 'supervisor' and e.branch_id = public.current_staff_branch())
        )
    )
  );

create policy "branch staff reads promo rule products" on promo_rule_products for select to authenticated
  using (
    exists (
      select 1 from promo_rules r
      join promo_events e on e.id = r.promo_event_id
      where r.id = promo_rule_products.promo_rule_id
        and (e.branch_id = public.current_staff_branch() or public.is_manager())
    )
  );

create policy "managers manage promo rule products" on promo_rule_products for all to authenticated
  using (
    exists (
      select 1 from promo_rules r
      join promo_events e on e.id = r.promo_event_id
      where r.id = promo_rule_products.promo_rule_id
        and (
          public.is_manager()
          or (public.current_staff_role() = 'supervisor' and e.branch_id = public.current_staff_branch())
        )
    )
  )
  with check (
    exists (
      select 1 from promo_rules r
      join promo_events e on e.id = r.promo_event_id
      where r.id = promo_rule_products.promo_rule_id
        and (
          public.is_manager()
          or (public.current_staff_role() = 'supervisor' and e.branch_id = public.current_staff_branch())
        )
    )
  );

drop policy if exists "read day ends" on day_ends;
drop policy if exists "write day ends" on day_ends;
drop policy if exists "update day ends" on day_ends;
create policy "read day ends" on day_ends for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());
create policy "write day ends" on day_ends for insert to authenticated
  with check (branch_id = public.current_staff_branch() or public.is_manager());
create policy "update day ends" on day_ends for update to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

create or replace function public.current_business_date(p_open_hour integer default 7)
returns date
language sql
stable
set search_path = public
as $$
  select case
    when extract(hour from (timezone('Asia/Manila', now()))) < greatest(0, least(23, coalesce(p_open_hour, 7)))
      then (timezone('Asia/Manila', now()))::date - 1
    else (timezone('Asia/Manila', now()))::date
  end;
$$;

create or replace function public.assert_till_open(p_branch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_open_hour integer;
  v_biz_date date;
begin
  select coalesce(day_open_hour, 7) into v_open_hour
  from branches
  where id = p_branch_id;

  v_open_hour := coalesce(v_open_hour, 7);
  v_biz_date := public.current_business_date(v_open_hour);

  select status into v_status
  from day_ends
  where branch_id = p_branch_id
    and business_date = v_biz_date;

  if v_status in ('closed', 'submitted') then
    raise exception 'Till is locked for this business day. Submit is pending approval or the day is closed — ask a manager.';
  end if;
end;
$$;

create or replace function public.business_date_for(p_when timestamptz, p_open_hour integer default 7)
returns date
language sql
stable
set search_path = public
as $$
  select case
    when extract(hour from (timezone('Asia/Manila', p_when))) < greatest(0, least(23, coalesce(p_open_hour, 7)))
      then (timezone('Asia/Manila', p_when))::date - 1
    else (timezone('Asia/Manila', p_when))::date
  end;
$$;

create or replace function public.assert_business_day_mutable(p_branch_id uuid, p_when timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_open_hour integer;
  v_biz_date date;
begin
  select coalesce(day_open_hour, 7) into v_open_hour
  from branches
  where id = p_branch_id;

  v_biz_date := public.business_date_for(p_when, coalesce(v_open_hour, 7));

  select status into v_status
  from day_ends
  where branch_id = p_branch_id
    and business_date = v_biz_date;

  if v_status in ('closed', 'submitted') then
    raise exception 'This business day is locked. Voids and refunds require the day to be reopened first.';
  end if;
end;
$$;

create or replace function public.submit_day_end(
  p_branch_id uuid,
  p_staff_id uuid,
  p_business_date date,
  p_recorded_cash numeric,
  p_cash_on_hand numeric,
  p_variance numeric,
  p_expected_cash numeric,
  p_note text default null,
  p_day_report jsonb default null,
  p_day_end_id uuid default null
)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized for this branch';
  end if;

  select * into v_row
  from day_ends
  where branch_id = p_branch_id
    and business_date = p_business_date
  for update;

  if found and v_row.status = 'closed' then
    raise exception 'Day is already closed';
  end if;

  if found then
    update day_ends
    set
      staff_id = p_staff_id,
      recorded_cash = p_recorded_cash,
      cash_on_hand = p_cash_on_hand,
      variance = p_variance,
      expected_cash = p_expected_cash,
      note = p_note,
      day_report = coalesce(p_day_report, day_report),
      status = 'submitted',
      submitted_at = now(),
      submitted_by = p_staff_id,
      approved_at = null,
      approved_by = null,
      closed_at = coalesce(closed_at, now()),
      reopened_at = null,
      reopened_by = null,
      reopen_reason = null
    where id = v_row.id
    returning * into v_row;
    return v_row;
  end if;

  insert into day_ends (
    branch_id, staff_id, business_date,
    recorded_cash, cash_on_hand, variance, expected_cash,
    note, day_report, status,
    submitted_at, submitted_by, closed_at
  ) values (
    p_branch_id, p_staff_id, p_business_date,
    p_recorded_cash, p_cash_on_hand, p_variance, p_expected_cash,
    p_note, p_day_report, 'submitted',
    now(), p_staff_id, now()
  )
  returning * into v_row;

  return v_row;
end;
$$;

create or replace function public.approve_day_end(p_day_end_id uuid, p_staff_id uuid)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'Only supervisors or managers can approve day close';
  end if;

  update day_ends
  set
    status = 'closed',
    approved_at = now(),
    approved_by = p_staff_id,
    closed_at = coalesce(closed_at, now())
  where id = p_day_end_id
    and status = 'submitted'
  returning * into v_row;

  if not found then
    raise exception 'No submitted day end found to approve';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_approved',
    'Approved close for ' || v_row.business_date::text,
    jsonb_build_object(
      'day_end_id', v_row.id,
      'business_date', v_row.business_date,
      'variance', v_row.variance,
      'cash_on_hand', v_row.cash_on_hand
    )
  );

  return v_row;
end;
$$;

create or replace function public.reopen_day_end(
  p_day_end_id uuid,
  p_staff_id uuid,
  p_reason text
)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends;
  v_reason text;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reopen the till';
  end if;

  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Reopen reason is required';
  end if;

  update day_ends
  set
    status = 'reopened',
    reopened_at = now(),
    reopened_by = p_staff_id,
    reopen_reason = v_reason
  where id = p_day_end_id
    and status = 'closed'
  returning * into v_row;

  if not found then
    raise exception 'Only a closed day can be reopened';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_reopen',
    'Reopened till for ' || v_row.business_date::text || ': ' || left(v_reason, 200),
    jsonb_build_object(
      'day_end_id', v_row.id,
      'business_date', v_row.business_date,
      'reason', v_reason
    )
  );

  return v_row;
end;
$$;

grant execute on function public.current_business_date(integer) to authenticated;
grant execute on function public.assert_till_open(uuid) to authenticated;
grant execute on function public.business_date_for(timestamptz, integer) to authenticated;
grant execute on function public.assert_business_day_mutable(uuid, timestamptz) to authenticated;
grant execute on function public.submit_day_end(uuid, uuid, date, numeric, numeric, numeric, numeric, text, jsonb, uuid) to authenticated;
grant execute on function public.approve_day_end(uuid, uuid) to authenticated;
grant execute on function public.reopen_day_end(uuid, uuid, text) to authenticated;

create policy "branch read import batches" on import_batches for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());
create policy "branch write import batches" on import_batches for all to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());
create policy "branch read import items" on import_batch_items for select to authenticated
  using (
    exists (
      select 1 from import_batches b
      where b.id = batch_id
        and (b.branch_id = public.current_staff_branch() or public.is_manager())
    )
  );
create policy "branch write import items" on import_batch_items for all to authenticated
  using (
    exists (
      select 1 from import_batches b
      where b.id = batch_id
        and (b.branch_id = public.current_staff_branch() or public.is_manager())
    )
  )
  with check (
    exists (
      select 1 from import_batches b
      where b.id = batch_id
        and (b.branch_id = public.current_staff_branch() or public.is_manager())
    )
  );

create or replace function public.record_stock_movement(
  p_branch_id uuid, p_product_id uuid, p_staff_id uuid, p_movement_type text,
  p_quantity_in numeric, p_quantity_out numeric, p_reference text default null, p_detail text default null
) returns public.stock_movements language plpgsql security definer set search_path = public as $$
declare v_stock numeric; v_movement public.stock_movements;
begin
  if p_branch_id <> public.current_staff_branch() and not public.is_manager() then
    raise exception 'Branch access denied';
  end if;
  insert into branch_inventory (branch_id, product_id, quantity_on_hand)
  values (p_branch_id, p_product_id, 0)
  on conflict (branch_id, product_id) do nothing;
  update branch_inventory
    set quantity_on_hand = quantity_on_hand + p_quantity_in - p_quantity_out, updated_at = now()
  where branch_id = p_branch_id and product_id = p_product_id
  returning quantity_on_hand into v_stock;
  insert into stock_movements (
    branch_id, product_id, staff_id, movement_type, reference, detail,
    quantity_in, quantity_out, quantity_on_hand_after
  ) values (
    p_branch_id, p_product_id, p_staff_id, p_movement_type, p_reference, p_detail,
    p_quantity_in, p_quantity_out, v_stock
  ) returning * into strict v_movement;
  return v_movement;
end;
$$;
grant execute on function public.record_stock_movement(uuid, uuid, uuid, text, numeric, numeric, text, text) to authenticated;

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
    p_branch_id, p_product_id, p_staff_id, 'price_change', 'price',
    coalesce(p_detail, 'Price update'),
    0, 0, v_stock, p_old_price, p_new_price
  )
  returning * into v_movement;

  return v_movement;
end;
$$;

grant execute on function public.record_price_change(uuid, uuid, uuid, numeric, numeric, text) to authenticated;

create or replace function public.revert_import_batch(p_batch_id uuid, p_staff_id uuid)
returns public.import_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.import_batches;
  v_item public.import_batch_items;
begin
  if not public.is_manager() then
    raise exception 'Only managers can revert imports';
  end if;

  select * into v_batch from import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Import batch not found';
  end if;
  if v_batch.status = 'reverted' then
    raise exception 'Import already reverted';
  end if;

  for v_item in
    select * from import_batch_items where batch_id = p_batch_id
  loop
    if v_item.quantity_added > 0 then
      perform public.record_stock_movement(
        v_batch.branch_id,
        v_item.product_id,
        p_staff_id,
        'adjustment',
        0,
        v_item.quantity_added,
        'revert:' || p_batch_id::text,
        'Revert import ' || coalesce(v_batch.filename, '')
      );
    end if;
    if v_item.action = 'create' then
      update products set is_active = false where id = v_item.product_id;
    end if;
  end loop;

  update import_batches
  set status = 'reverted', reverted_at = now(), reverted_by = p_staff_id
  where id = p_batch_id
  returning * into strict v_batch;

  return v_batch;
end;
$$;
grant execute on function public.revert_import_batch(uuid, uuid) to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_branch uuid; v_role text; v_name text;
begin
  v_branch := nullif(new.raw_user_meta_data->>'branch_id', '')::uuid;
  v_role := coalesce(nullif(new.raw_user_meta_data->>'role', ''), 'cashier');
  v_name := coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), split_part(new.email, '@', 1));
  if v_branch is null then
    select id into v_branch from branches where is_active order by created_at limit 1;
  end if;
  if v_branch is not null and not exists (select 1 from staff where auth_user_id = new.id) then
    insert into staff (auth_user_id, branch_id, full_name, role)
    values (new.id, v_branch, v_name, v_role);
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

insert into branches (name, address)
select 'Bayombong Branch #001', 'Bayombong, Nueva Vizcaya'
where not exists (select 1 from branches where name = 'Bayombong Branch #001');

insert into categories (name) values ('Meat'), ('Bakery'), ('Groceries') on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- 8. Presence / devices
-- ---------------------------------------------------------------------------
create table if not exists branch_presence (
  branch_id uuid primary key references branches(id) on delete cascade,
  staff_id uuid references staff(id) on delete set null,
  last_seen_at timestamptz not null default now(),
  is_online boolean not null default true,
  app_version text,
  user_agent text,
  updated_at timestamptz not null default now()
);

create table if not exists branch_devices (
  branch_id uuid not null references branches(id) on delete cascade,
  device_key text not null check (device_key in ('barcode_scanner', 'receipt_printer', 'cash_drawer')),
  state text not null default 'disconnected'
    check (state in ('disconnected', 'connecting', 'connected', 'error')),
  detail text,
  updated_at timestamptz not null default now(),
  primary key (branch_id, device_key)
);

-- ---------------------------------------------------------------------------
-- 9. PIN lockout (Auth hardening) — see migrate_pin_security_hardening.sql
-- ---------------------------------------------------------------------------
create table if not exists pin_login_attempts (
  login_code text primary key,
  fail_count integer not null default 0,
  locked_until timestamptz null,
  last_attempt_at timestamptz not null default now()
);
alter table pin_login_attempts enable row level security;
drop policy if exists "deny all pin_login_attempts" on pin_login_attempts;
create policy "deny all pin_login_attempts" on pin_login_attempts
  for all to authenticated, anon
  using (false)
  with check (false);
