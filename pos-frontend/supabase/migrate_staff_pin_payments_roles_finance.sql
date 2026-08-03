-- CalePOS: staff PIN login, payment methods, supervisor roles, VAT/PWD fields,
-- petty cash, clock-in shifts, branch sort order
-- Run once in Supabase SQL editor (safe to re-run).

-- ── Helpers first (RLS policies below depend on these) ─────────────
create or replace function public.current_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from staff where auth_user_id = auth.uid() and is_active limit 1;
$$;

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from staff
    where auth_user_id = auth.uid()
      and is_active
      and role in ('manager', 'admin', 'master')
  );
$$;

create or replace function public.is_supervisor_or_above()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from staff
    where auth_user_id = auth.uid()
      and is_active
      and role in ('supervisor', 'manager', 'admin', 'master')
  );
$$;

grant execute on function public.current_staff_id() to authenticated;
grant execute on function public.is_manager() to authenticated;
grant execute on function public.is_supervisor_or_above() to authenticated;

-- ── Roles ──────────────────────────────────────────────────────────
insert into roles (name, label, sort_order) values
  ('supervisor', 'Supervisor', 2),
  ('manager', 'Manager', 3),
  ('admin', 'Admin', 4),
  ('master', 'Master', 5)
on conflict (name) do update
set label = excluded.label, sort_order = excluded.sort_order;

update roles set sort_order = 1, label = 'Cashier' where name = 'cashier';

alter table staff drop constraint if exists staff_role_check;
alter table staff drop constraint if exists staff_role_fkey;

do $$ begin
  alter table staff
    add constraint staff_role_fkey
    foreign key (role) references roles(name)
    on update cascade on delete restrict;
exception when duplicate_object then null;
end $$;

-- ── Staff PIN / permissions ────────────────────────────────────────
alter table staff add column if not exists login_code text;
alter table staff add column if not exists login_pin text;
alter table staff add column if not exists permissions jsonb;
alter table staff add column if not exists auth_secret text;
-- Remove mistaken column from an earlier draft of this migration (cost belongs on products)
alter table staff drop column if exists unit_cost;

-- Prefer global uniqueness (staff code identifies the person at login)
drop index if exists staff_branch_login_code_uidx;

create unique index if not exists staff_login_code_uidx
  on staff (login_code)
  where login_code is not null and login_code <> '';

-- ── Payment methods + void approval + VAT / discount ───────────────
alter table transactions
  add column if not exists payment_method text not null default 'cash'
    check (payment_method in ('cash', 'card', 'ewallet'));
alter table transactions
  add column if not exists payment_reference text;
alter table transactions
  add column if not exists void_approved_by uuid references staff(id) on delete set null;
alter table transactions
  add column if not exists vat_amount numeric(12,2) not null default 0;
alter table transactions
  add column if not exists vatable_sales numeric(12,2) not null default 0;
alter table transactions
  add column if not exists discount_amount numeric(12,2) not null default 0;
alter table transactions
  add column if not exists discount_type text;
alter table transactions
  add column if not exists discount_id_note text;

-- ── Products: cost + PWD/Senior eligibility ─────────────────────────
alter table products
  add column if not exists unit_cost numeric(12,2) not null default 0;
alter table products
  add column if not exists discount_eligible boolean not null default false;

-- ── Branches: sort + VAT rate ──────────────────────────────────────
alter table branches
  add column if not exists sort_order integer not null default 0;
alter table branches
  add column if not exists vat_rate numeric(6,4) not null default 0.12;

update branches b
set sort_order = sub.rn
from (
  select id, row_number() over (order by name, id) as rn from branches
) sub
where b.id = sub.id and (b.sort_order = 0 or b.sort_order is null);

-- ── Petty cash ─────────────────────────────────────────────────────
create table if not exists petty_cash (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  staff_id uuid references staff(id) on delete set null,
  amount numeric(12,2) not null,
  reason text not null default '',
  business_date date not null default (timezone('Asia/Manila', now()))::date,
  created_at timestamptz not null default now()
);

alter table petty_cash enable row level security;
drop policy if exists "read petty cash" on petty_cash;
create policy "read petty cash" on petty_cash for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());
drop policy if exists "write petty cash" on petty_cash;
create policy "write petty cash" on petty_cash for all to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

-- ── Staff shifts (clock in/out) ────────────────────────────────────
create table if not exists staff_shifts (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  staff_id uuid not null references staff(id) on delete cascade,
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  created_at timestamptz not null default now()
);

alter table staff_shifts enable row level security;
drop policy if exists "read staff shifts" on staff_shifts;
create policy "read staff shifts" on staff_shifts for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager() or staff_id = public.current_staff_id());
drop policy if exists "write staff shifts" on staff_shifts;
create policy "write staff shifts" on staff_shifts for all to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager() or staff_id = public.current_staff_id())
  with check (branch_id = public.current_staff_branch() or public.is_manager() or staff_id = public.current_staff_id());

-- ── PIN login RPC ──────────────────────────────────────────────────
drop function if exists public.resolve_pin_login(text, text);

create or replace function public.resolve_pin_login(p_login_code text, p_pin text)
returns table (
  auth_email text,
  auth_password text,
  staff_id uuid,
  full_name text,
  role text,
  branch_id uuid
)
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_staff public.staff%rowtype;
  v_email text;
  v_password text;
begin
  if p_login_code is null or length(trim(p_login_code)) < 4 then
    raise exception 'Invalid staff code';
  end if;

  select s.* into v_staff
  from public.staff s
  where s.login_code = trim(p_login_code)
    and s.is_active
    and s.role in ('cashier', 'supervisor')
  limit 1;

  if not found then
    raise exception 'Invalid staff code or PIN';
  end if;

  if v_staff.login_pin is distinct from trim(p_pin) then
    raise exception 'Invalid staff code or PIN';
  end if;

  select u.email into v_email
  from auth.users u
  where u.id = v_staff.auth_user_id;

  if v_email is null then
    raise exception 'Staff account is not linked to a login';
  end if;

  v_password := nullif(trim(coalesce(v_staff.auth_secret, '')), '');
  if v_password is null then
    v_password := trim(p_pin);
  end if;

  update auth.users
  set
    encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
    email_confirmed_at = coalesce(email_confirmed_at, now()),
    updated_at = now()
  where id = v_staff.auth_user_id;

  if v_staff.auth_secret is null or v_staff.auth_secret = '' then
    update public.staff set auth_secret = v_password where id = v_staff.id;
  end if;

  auth_email := v_email;
  auth_password := v_password;
  staff_id := v_staff.id;
  full_name := v_staff.full_name;
  role := v_staff.role;
  branch_id := v_staff.branch_id;
  return next;
end;
$$;

grant execute on function public.resolve_pin_login(text, text) to anon, authenticated;

-- ── Supervisor PIN for void / price approval ───────────────────────
create or replace function public.verify_supervisor_pin(
  p_branch_id uuid,
  p_login_code text,
  p_pin text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id
  from staff
  where branch_id = p_branch_id
    and login_code = trim(p_login_code)
    and login_pin = trim(p_pin)
    and is_active
    and role in ('supervisor', 'manager', 'admin', 'master')
  limit 1;
  if v_id is null then
    raise exception 'Supervisor approval failed';
  end if;
  return v_id;
end;
$$;

grant execute on function public.verify_supervisor_pin(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
