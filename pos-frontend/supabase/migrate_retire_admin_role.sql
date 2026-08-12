-- Retire the `admin` staff role. Master is the only top-of-tree account.
-- Safe to re-run.
--
-- WHAT
-- ----
-- 1. Remap every staff.role = 'admin' → 'manager' (office power without master).
-- 2. Drop `admin` from the roles lookup so Staff cannot assign it (FK).
-- 3. Keep role_rank('admin') = 40 for any transient leftover during apply.
--
-- Apply after migrate_role_assignment_ceiling.sql (needs role_rank / roles table).
-- Frontend already refuses assigning `admin` (roles.js canAssignRole).

-- ---------------------------------------------------------------------------
-- 1. Remap existing admin accounts
-- ---------------------------------------------------------------------------
update public.staff
set role = 'manager'
where role = 'admin';

-- ---------------------------------------------------------------------------
-- 2. Remove from lookup (staff.role FK → roles.name)
-- ---------------------------------------------------------------------------
delete from public.roles
where name = 'admin';

-- ---------------------------------------------------------------------------
-- 3. role_rank kept with admin branch so a stray JWT/row never ranks as 0
--    mid-apply. New assigns cannot use admin after step 2.
-- ---------------------------------------------------------------------------
create or replace function public.role_rank(p_role text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_role
    when 'cashier'    then 10
    when 'supervisor' then 20
    when 'manager'    then 30
    when 'admin'      then 40  -- retired; should not appear on staff rows
    when 'master'     then 50
    else 0
  end;
$$;
