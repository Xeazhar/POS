create extension if not exists pgcrypto;

create table branches (
  id uuid primary key default gen_random_uuid(), name text not null, address text,
  is_active boolean not null default true, created_at timestamptz not null default now()
);
create table staff (
  id uuid primary key default gen_random_uuid(), auth_user_id uuid references auth.users(id) on delete cascade unique,
  branch_id uuid not null references branches(id) on delete restrict, full_name text not null,
  role text not null check (role in ('cashier', 'manager', 'admin')), is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_staff_branch on staff(branch_id);
create table categories (
  id uuid primary key default gen_random_uuid(), name text not null unique, created_at timestamptz not null default now()
);
create table products (
  id uuid primary key default gen_random_uuid(), category_id uuid references categories(id) on delete set null,
  name text not null, sku text not null unique, barcode text unique,
  pricing_mode text not null check (pricing_mode in ('per_unit', 'per_kg')),
  price numeric(10,2) not null check (price >= 0), low_stock_threshold numeric(10,2) not null default 10,
  medium_stock_threshold numeric(10,2) not null default 30, is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_products_category on products(category_id);
create index idx_products_sku on products(sku);
create index idx_products_barcode on products(barcode);
create table branch_inventory (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade, quantity_on_hand numeric(10,2) not null default 0,
  updated_at timestamptz not null default now(), unique (branch_id, product_id)
);
create index idx_inventory_branch on branch_inventory(branch_id);
create index idx_inventory_product on branch_inventory(product_id);
create table stock_movements (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade, staff_id uuid references staff(id) on delete set null,
  movement_type text not null check (movement_type in ('restock', 'sale', 'adjustment', 'shrinkage')),
  reference text, detail text, quantity_in numeric(10,2) not null default 0, quantity_out numeric(10,2) not null default 0,
  quantity_on_hand_after numeric(10,2) not null, created_at timestamptz not null default now()
);
create index idx_movements_branch_product on stock_movements(branch_id, product_id);
create index idx_movements_date on stock_movements(created_at);
create table transactions (
  id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id) on delete restrict,
  staff_id uuid references staff(id) on delete set null, total_amount numeric(10,2) not null check (total_amount >= 0),
  amount_tendered numeric(10,2), change_given numeric(10,2), status text not null check (status in ('completed', 'voided')) default 'completed',
  void_reason text, created_at timestamptz not null default now()
);
create index idx_transactions_branch on transactions(branch_id);
create index idx_transactions_date on transactions(created_at);
create table transaction_items (
  id uuid primary key default gen_random_uuid(), transaction_id uuid not null references transactions(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict, quantity numeric(10,2) not null check (quantity > 0),
  unit_price numeric(10,2) not null, line_total numeric(10,2) not null
);
create index idx_txn_items_transaction on transaction_items(transaction_id);

alter table branches enable row level security;
alter table staff enable row level security;
alter table categories enable row level security;
alter table products enable row level security;
alter table branch_inventory enable row level security;
alter table stock_movements enable row level security;
alter table transactions enable row level security;
alter table transaction_items enable row level security;

create or replace function public.current_staff_role() returns text language sql stable security definer set search_path = public as $$
  select role from public.staff where auth_user_id = auth.uid() and is_active = true limit 1;
$$;
create or replace function public.current_staff_branch() returns uuid language sql stable security definer set search_path = public as $$
  select branch_id from public.staff where auth_user_id = auth.uid() and is_active = true limit 1;
$$;

create policy "staff reads own branch" on branches for select to authenticated using (id = public.current_staff_branch());
create policy "staff reads own profile" on staff for select to authenticated using (auth_user_id = auth.uid());
create policy "staff reads categories" on categories for select to authenticated using (true);
create policy "staff reads products" on products for select to authenticated using (is_active = true);
create policy "managers write products" on products for all to authenticated using (public.current_staff_role() in ('manager', 'admin')) with check (public.current_staff_role() in ('manager', 'admin'));
create policy "staff sees own branch inventory" on branch_inventory for select to authenticated using (branch_id = public.current_staff_branch());
create policy "managers adjust own branch inventory" on branch_inventory for all to authenticated using (branch_id = public.current_staff_branch() and public.current_staff_role() in ('manager', 'admin')) with check (branch_id = public.current_staff_branch());
create policy "staff sees own branch movements" on stock_movements for select to authenticated using (branch_id = public.current_staff_branch());
create policy "staff creates own branch movements" on stock_movements for insert to authenticated with check (branch_id = public.current_staff_branch());
create policy "staff sees own branch transactions" on transactions for select to authenticated using (branch_id = public.current_staff_branch());
create policy "staff creates own branch transactions" on transactions for insert to authenticated with check (branch_id = public.current_staff_branch());
create policy "managers void own branch transactions" on transactions for update to authenticated using (branch_id = public.current_staff_branch() and public.current_staff_role() in ('manager', 'admin')) with check (branch_id = public.current_staff_branch());
create policy "staff sees transaction items" on transaction_items for select to authenticated using (exists (select 1 from transactions t where t.id = transaction_id and t.branch_id = public.current_staff_branch()));
create policy "staff creates transaction items" on transaction_items for insert to authenticated with check (exists (select 1 from transactions t where t.id = transaction_id and t.branch_id = public.current_staff_branch()));

create or replace function public.record_stock_movement(
  p_branch_id uuid, p_product_id uuid, p_staff_id uuid, p_movement_type text,
  p_quantity_in numeric, p_quantity_out numeric, p_reference text default null, p_detail text default null
) returns public.stock_movements language plpgsql security definer set search_path = public as $$
declare v_stock numeric; v_movement public.stock_movements;
begin
  if p_branch_id <> public.current_staff_branch() then raise exception 'Branch access denied'; end if;
  insert into branch_inventory (branch_id, product_id, quantity_on_hand) values (p_branch_id, p_product_id, 0)
    on conflict (branch_id, product_id) do nothing;
  update branch_inventory set quantity_on_hand = quantity_on_hand + p_quantity_in - p_quantity_out, updated_at = now()
    where branch_id = p_branch_id and product_id = p_product_id returning quantity_on_hand into v_stock;
  if v_stock < 0 then raise exception 'Insufficient stock'; end if;
  insert into stock_movements (branch_id, product_id, staff_id, movement_type, reference, detail, quantity_in, quantity_out, quantity_on_hand_after)
    values (p_branch_id, p_product_id, p_staff_id, p_movement_type, p_reference, p_detail, p_quantity_in, p_quantity_out, v_stock)
    returning * into strict v_movement;
  return v_movement;
end;
$$;
grant execute on function public.record_stock_movement(uuid, uuid, uuid, text, numeric, numeric, text, text) to authenticated;

insert into branches (name, address) select 'CalePOS Main Shop', 'Current demo branch' where not exists (select 1 from branches);
insert into categories (name) values ('Meat'), ('Bakery'), ('Groceries') on conflict (name) do nothing;
