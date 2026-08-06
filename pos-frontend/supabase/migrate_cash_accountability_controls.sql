-- Change fund at shift start + petty cash request/approve workflow.
-- Prefer cash_drawer_entries; create/rename from petty_cash when needed.
-- Prefer running migrate_rename_petty_cash_to_cash_drawer_entries.sql instead —
-- this file remains for older apply orders and is idempotent against either table name.

do $$
begin
  if to_regclass('public.petty_cash') is not null
     and to_regclass('public.cash_drawer_entries') is null then
    alter table public.petty_cash rename to cash_drawer_entries;
  end if;
end $$;

create table if not exists public.cash_drawer_entries (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete cascade,
  staff_id uuid references public.staff(id) on delete set null,
  amount numeric(12,2) not null,
  reason text not null default '',
  business_date date not null default (timezone('Asia/Manila', now()))::date,
  created_at timestamptz not null default now()
);

alter table public.cash_drawer_entries add column if not exists kind text;
alter table public.cash_drawer_entries add column if not exists status text;
alter table public.cash_drawer_entries add column if not exists receipt_ref text;
alter table public.cash_drawer_entries add column if not exists shift_id uuid references public.staff_shifts(id) on delete set null;
alter table public.cash_drawer_entries add column if not exists requested_by uuid references public.staff(id) on delete set null;
alter table public.cash_drawer_entries add column if not exists approved_by uuid references public.staff(id) on delete set null;
alter table public.cash_drawer_entries add column if not exists approved_at timestamptz;
alter table public.cash_drawer_entries add column if not exists confirmed_by uuid references public.staff(id) on delete set null;
alter table public.cash_drawer_entries add column if not exists confirmed_at timestamptz;
alter table public.cash_drawer_entries add column if not exists reject_reason text;

update public.cash_drawer_entries
set kind = case
  when reason ~* '^\[CHANGE FUND\]' then 'change_fund'
  when reason ~* '^\[PICKUP\]' then 'pickup'
  else 'paid_out'
end
where kind is null;

update public.cash_drawer_entries
set status = case
  when kind = 'paid_out' then 'approved'
  else 'recorded'
end
where status is null;

alter table public.cash_drawer_entries alter column kind set default 'paid_out';
alter table public.cash_drawer_entries alter column status set default 'approved';

update public.cash_drawer_entries set kind = 'paid_out' where kind is null;
update public.cash_drawer_entries set status = 'approved' where status is null;

alter table public.cash_drawer_entries alter column kind set not null;
alter table public.cash_drawer_entries alter column status set not null;

alter table public.cash_drawer_entries drop constraint if exists petty_cash_kind_check;
alter table public.cash_drawer_entries drop constraint if exists petty_cash_status_check;
alter table public.cash_drawer_entries drop constraint if exists cash_drawer_entries_kind_check;
alter table public.cash_drawer_entries drop constraint if exists cash_drawer_entries_status_check;

alter table public.cash_drawer_entries
  add constraint cash_drawer_entries_kind_check
  check (kind in ('change_fund', 'pickup', 'paid_out'));

alter table public.cash_drawer_entries
  add constraint cash_drawer_entries_status_check
  check (status in ('pending', 'approved', 'rejected', 'recorded'));

create unique index if not exists uq_cash_drawer_entries_change_fund_shift
  on public.cash_drawer_entries (shift_id)
  where kind = 'change_fund' and shift_id is not null;

create index if not exists idx_cash_drawer_entries_status_kind
  on public.cash_drawer_entries (branch_id, status, kind);

create index if not exists idx_cash_drawer_entries_pending
  on public.cash_drawer_entries (branch_id, created_at desc)
  where status = 'pending' and kind = 'paid_out';

alter table public.cash_drawer_entries enable row level security;

drop policy if exists "read petty cash" on public.cash_drawer_entries;
drop policy if exists "write petty cash" on public.cash_drawer_entries;
drop policy if exists "read cash drawer entries" on public.cash_drawer_entries;
drop policy if exists "write cash drawer entries" on public.cash_drawer_entries;

create policy "read cash drawer entries" on public.cash_drawer_entries
  for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());

create policy "write cash drawer entries" on public.cash_drawer_entries
  for all to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());
