-- Manager-authored announcements, read by staff on CashierDashboard.jsx (and by
-- managers on ManagerAnnouncements.jsx for their own management list). Modeled on
-- migrate_refund_requests.sql's shape (manager-authored, branch-scoped-or-cross-branch
-- via is_manager(), no branch silo for managers/admin/master).
--
-- branch_id NULL = network-wide (visible at every branch). No hard delete — managers
-- deactivate (is_active) instead, same "expire, don't delete" pattern as promos.
--
-- Unread tracking is a single watermark per staff (staff.announcements_seen_at), not a
-- per-item read-receipt table: an item is unread if its created_at is after the staff
-- member's watermark. mark_announcements_seen() bumps the watermark and returns the
-- PREVIOUS value so the caller can compute this visit's unread set before it moves.

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references public.branches(id) on delete cascade,
  author_id uuid not null references public.staff(id),
  kind text not null default 'general'
    check (kind in ('promo', 'price', 'reminder', 'maintenance', 'general')),
  title text not null,
  body text not null,
  is_active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_announcements_branch_created
  on public.announcements(branch_id, created_at desc);

alter table public.announcements enable row level security;

drop policy if exists "read announcements" on public.announcements;
drop policy if exists "create announcements" on public.announcements;
drop policy if exists "update announcements" on public.announcements;

-- Managers see every row (their own management list needs inactive/expired ones too).
-- Everyone else sees only what's currently live and scoped to their branch (or network-wide).
create policy "read announcements" on public.announcements for select to authenticated
  using (
    (select public.is_manager())
    or (
      is_active
      and (expires_at is null or expires_at > now())
      and (branch_id is null or branch_id = (select public.current_staff_branch()))
    )
  );

create policy "create announcements" on public.announcements for insert to authenticated
  with check ((select public.is_manager()) and author_id = (select public.current_staff_id()));

create policy "update announcements" on public.announcements for update to authenticated
  using ((select public.is_manager()))
  with check ((select public.is_manager()));

alter table public.staff add column if not exists announcements_seen_at timestamptz;

-- Bumps the caller's own watermark and hands back what it was before, so the dashboard
-- can flag "posted since your last visit" for this load before the watermark moves.
create or replace function public.mark_announcements_seen()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid := public.current_staff_id();
  v_prev timestamptz;
begin
  if v_staff_id is null then
    raise exception 'Not signed in';
  end if;

  select announcements_seen_at into v_prev from public.staff where id = v_staff_id;
  update public.staff set announcements_seen_at = now() where id = v_staff_id;

  return v_prev;
end;
$$;

grant execute on function public.mark_announcements_seen() to authenticated;

notify pgrst, 'reload schema';
