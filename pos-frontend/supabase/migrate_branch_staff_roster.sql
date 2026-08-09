-- Let a supervisor see their own branch's staff roster — without seeing anyone's PIN.
--
-- THE PROBLEM: the `read staff` policy is
--     using (auth_user_id = auth.uid() or public.is_manager())
-- so a supervisor can read exactly one row: their own. The Staff page therefore showed
-- them a list of one person, which is the "partial list" complaint.
--
-- WHY NOT JUST WIDEN THE POLICY: `staff.login_pin` and `staff.auth_secret` are stored in
-- plaintext on that table, and RLS is row-level, not column-level. A policy that lets a
-- supervisor SELECT their branch's rows lets them SELECT login_pin on those rows too —
-- every cashier's till PIN, readable by anyone who opens the network tab. That is a much
-- worse problem than the one being fixed.
--
-- INSTEAD: a security definer function that returns only the columns the roster screen
-- actually renders. Same shape as drawer_holder() / drawer_last_count() in
-- migrate_shift_cash_accountability.sql — a narrow definer function is how this codebase
-- already hands a lower role a specific fact without handing it the table.
--
-- Apply any time after the base schema. Safe to re-run.

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
  -- NOTE the column list: no login_pin, no auth_secret, no active_session_id. Adding one
  -- here is the same as granting every supervisor access to it, so do not.
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
    -- Managers: any branch, optionally narrowed by the caller.
    (
      public.is_manager()
      and (p_branch_id is null or s.branch_id = p_branch_id)
    )
    -- Supervisors: their OWN branch only, regardless of what they pass in. The argument
    -- is a filter for managers, never a way for a supervisor to look sideways.
    or (
      public.is_supervisor_or_above()
      and not public.is_manager()
      and s.branch_id = public.current_staff_branch()
    )
  order by s.is_active desc, s.full_name;
$$;

-- `login_code` is included deliberately: a supervisor already has to read staff codes off
-- the till to help someone sign in, and it is not a secret on its own — the PIN is. If
-- that ever changes, drop the column from the select list above.

grant execute on function public.branch_staff_roster(uuid) to authenticated;

-- Verify
--   as a manager:    select * from public.branch_staff_roster();
--   as a supervisor: select * from public.branch_staff_roster();          -- own branch
--                    select * from public.branch_staff_roster('<other>'); -- still own branch
--   confirm the leak is closed:
--     select login_pin from public.staff;   -- must still return only your own row
