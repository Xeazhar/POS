create extension if not exists pgcrypto;

create table if not exists branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  is_active boolean not null default true,
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
  ('manager', 'Manager', 2),
  ('admin', 'Admin', 3)
on conflict (name) do nothing;

create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users(id) on delete cascade unique,
  branch_id uuid not null references branches(id) on delete restrict,
  full_name text not null,
  role text not null references roles(name) on update cascade on delete restrict,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_staff_branch on staff(branch_id);

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  category_id uuid references categories(id) on delete set null,
  name text not null,
  sku text not null,
  barcode text,
  pricing_mode text not null check (pricing_mode in ('per_unit', 'per_kg')),
  price numeric(10,2) not null check (price >= 0),
  low_stock_threshold numeric(10,2) not null default 10,
  medium_stock_threshold numeric(10,2) not null default 30,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (branch_id, sku),
  unique (branch_id, barcode)
);
create index if not exists idx_products_branch on products(branch_id);
create index if not exists idx_products_sku on products(branch_id, sku);
create index if not exists idx_products_barcode on products(branch_id, barcode);

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
  movement_type text not null check (movement_type in ('restock', 'sale', 'adjustment', 'shrinkage', 'update')),
  reference text,
  detail text,
  quantity_in numeric(10,2) not null default 0,
  quantity_out numeric(10,2) not null default 0,
  quantity_on_hand_after numeric(10,2) not null,
  created_at timestamptz not null default now()
);

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete restrict,
  staff_id uuid references staff(id) on delete set null,
  total_amount numeric(10,2) not null check (total_amount >= 0),
  amount_tendered numeric(10,2),
  change_given numeric(10,2),
  status text not null check (status in ('completed', 'voided')) default 'completed',
  void_reason text,
  created_at timestamptz not null default now()
);

create table if not exists transaction_items (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  quantity numeric(10,2) not null check (quantity > 0),
  unit_price numeric(10,2) not null,
  line_total numeric(10,2) not null
);

create table if not exists day_ends (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  staff_id uuid references staff(id) on delete set null,
  business_date date not null,
  recorded_cash numeric(10,2) not null default 0,
  cash_on_hand numeric(10,2) not null default 0,
  variance numeric(10,2) not null default 0,
  note text,
  closed_at timestamptz not null default now(),
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

alter table branches enable row level security;
alter table staff enable row level security;
alter table roles enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table branch_inventory enable row level security;
alter table stock_movements enable row level security;
alter table transactions enable row level security;
alter table transaction_items enable row level security;
alter table day_ends enable row level security;
alter table import_batches enable row level security;
alter table import_batch_items enable row level security;

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
  select coalesce(public.current_staff_role() in ('manager', 'admin'), false);
$$;

drop policy if exists "staff reads own branch" on branches;
drop policy if exists "managers read all branches" on branches;
drop policy if exists "managers write branches" on branches;
create policy "read branches" on branches for select to authenticated
  using (id = public.current_staff_branch() or public.is_manager());
create policy "managers write branches" on branches for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "staff reads own profile" on staff;
drop policy if exists "managers manage staff" on staff;
create policy "read staff" on staff for select to authenticated
  using (auth_user_id = auth.uid() or public.is_manager());
create policy "managers manage staff" on staff for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

create policy "read roles" on roles for select to authenticated using (true);
create policy "managers write roles" on roles for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "staff reads categories" on categories;
create policy "read categories" on categories for select to authenticated using (true);
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
create policy "read inventory" on branch_inventory for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());
create policy "write inventory" on branch_inventory for all to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

drop policy if exists "staff sees own branch movements" on stock_movements;
drop policy if exists "staff creates own branch movements" on stock_movements;
create policy "read movements" on stock_movements for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());
create policy "write movements" on stock_movements for insert to authenticated
  with check (branch_id = public.current_staff_branch() or public.is_manager());

drop policy if exists "staff sees own branch transactions" on transactions;
drop policy if exists "staff creates own branch transactions" on transactions;
drop policy if exists "managers void own branch transactions" on transactions;
create policy "read transactions" on transactions for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());
create policy "write transactions" on transactions for insert to authenticated
  with check (branch_id = public.current_staff_branch() or public.is_manager());
create policy "update transactions" on transactions for update to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

drop policy if exists "staff sees transaction items" on transaction_items;
drop policy if exists "staff creates transaction items" on transaction_items;
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

create policy "read day ends" on day_ends for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());
create policy "write day ends" on day_ends for insert to authenticated
  with check (branch_id = public.current_staff_branch() or public.is_manager());

create policy "managers read import batches" on import_batches for select to authenticated
  using (public.is_manager());
create policy "managers write import batches" on import_batches for all to authenticated
  using (public.is_manager()) with check (public.is_manager());
create policy "managers read import items" on import_batch_items for select to authenticated
  using (public.is_manager());
create policy "managers write import items" on import_batch_items for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

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
