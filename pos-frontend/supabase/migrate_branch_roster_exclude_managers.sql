-- A branch's staff roster (Staff page, supervisor view) should show the people who work
-- that branch — not a manager/admin/master account, which oversees every branch and isn't
-- "this branch's staff" in any meaningful sense to a supervisor reading the roster.
--
-- branch_staff_roster() (migrate_branch_staff_roster.sql) already scopes a supervisor to
-- their own branch correctly — this only narrows WHICH ROLES show up in that branch's
-- rows, it does not change the branch scoping itself. The manager branch of the same
-- function is untouched: a manager managing accounts still needs to see manager/admin
-- rows to do that job.
--
-- Apply after migrate_branch_staff_roster.sql. Safe to re-run.

create or replace function public.branch_staff_roster(p_branch_id uuid default null)
returns table (
  id uuid,
  branch_id uuid,
  branch_name text,
  full_name text,
  role text,
  is_active boolean,
  login_code text,
  permissions jsonb,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id,
         s.branch_id,
         b.name,
         s.full_name,
         s.role,
         s.is_active,
         s.login_code,
         s.permissions,
         s.created_at
  from public.staff s
  left join public.branches b on b.id = s.branch_id
  where
    -- Managers: any branch, optionally narrowed by the caller. Manager/admin/master rows
    -- stay visible here — a manager managing accounts needs to see them.
    (
      public.is_manager()
      and (p_branch_id is null or s.branch_id = p_branch_id)
    )
    -- Supervisors: their OWN branch only, regardless of what they pass in, and only the
    -- roles that actually belong to a single branch (cashier/supervisor). Manager/admin/
    -- master oversee every branch, not just this one, so they are not "this branch's
    -- staff" even when their row happens to carry this branch_id.
    or (
      public.is_supervisor_or_above()
      and not public.is_manager()
      and s.branch_id = public.current_staff_branch()
      and s.role not in ('manager', 'admin', 'master')
    )
  order by s.is_active desc, s.full_name;
$$;

grant execute on function public.branch_staff_roster(uuid) to authenticated;

-- Verify
--   as a supervisor: select * from public.branch_staff_roster();  -- no manager/admin/master rows
