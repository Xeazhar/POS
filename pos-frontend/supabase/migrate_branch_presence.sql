-- Branch network presence + device status (manager monitoring)

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

alter table branch_presence enable row level security;
alter table branch_devices enable row level security;

drop policy if exists "read branch presence" on branch_presence;
create policy "read branch presence" on branch_presence for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());

drop policy if exists "upsert branch presence" on branch_presence;
create policy "upsert branch presence" on branch_presence for insert to authenticated
  with check (branch_id = public.current_staff_branch() or public.is_manager());
create policy "update branch presence" on branch_presence for update to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

drop policy if exists "read branch devices" on branch_devices;
create policy "read branch devices" on branch_devices for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());

drop policy if exists "write branch devices" on branch_devices;
create policy "write branch devices" on branch_devices for all to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

create or replace function public.heartbeat_branch(
  p_branch_id uuid,
  p_staff_id uuid default null,
  p_app_version text default null,
  p_user_agent text default null
)
returns public.branch_presence
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.branch_presence;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not allowed to heartbeat this branch';
  end if;

  insert into branch_presence (branch_id, staff_id, last_seen_at, is_online, app_version, user_agent, updated_at)
  values (p_branch_id, p_staff_id, now(), true, p_app_version, p_user_agent, now())
  on conflict (branch_id) do update set
    staff_id = excluded.staff_id,
    last_seen_at = now(),
    is_online = true,
    app_version = excluded.app_version,
    user_agent = excluded.user_agent,
    updated_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.heartbeat_branch(uuid, uuid, text, text) to authenticated;
