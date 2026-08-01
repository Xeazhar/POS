-- Roles lookup so Supabase Table Editor can pick role from related records
-- (no more free-typing cashier/manager/admin)

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
on conflict (name) do update
set label = excluded.label,
    sort_order = excluded.sort_order;

-- Drop old check constraint if present (name may vary)
alter table staff drop constraint if exists staff_role_check;

-- Normalize any unexpected values before FK
update staff set role = 'cashier' where role is null or role not in ('cashier', 'manager', 'admin');

do $$ begin
  alter table staff
    add constraint staff_role_fkey
    foreign key (role) references roles(name)
    on update cascade
    on delete restrict;
exception
  when duplicate_object then null;
end $$;

alter table roles enable row level security;

drop policy if exists "read roles" on roles;
create policy "read roles" on roles for select to authenticated using (true);

drop policy if exists "managers write roles" on roles;
create policy "managers write roles" on roles for all to authenticated
  using (public.is_manager()) with check (public.is_manager());
