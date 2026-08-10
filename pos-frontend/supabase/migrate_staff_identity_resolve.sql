-- Let a supervisor resolve a name + role for staff ids they encounter in reports/logs
-- (the void/refund audit trail, the shift log) without widening the `staff` table's RLS.
--
-- THE PROBLEM: `read staff` on the `staff` table is
--     using (auth_user_id = auth.uid() or public.is_manager())
-- so a supervisor's session can read exactly one row: their own. Any PostgREST embed that
-- joins to `staff` (e.g. `sale_events.select('*, staff(full_name)')`,
-- `staff_shifts.select('staff:staff_id(full_name, role)')`) is filtered by that same policy
-- for every OTHER staff id, so it silently comes back null. A supervisor opening the
-- dashboard's Audit panel sees void/refund rows with no "performed by" for anyone but
-- themselves — not because the data isn't there, but because RLS ate the join.
--
-- WHY NOT JUST WIDEN THE POLICY: same reason as migrate_branch_staff_roster.sql —
-- `staff.login_pin`/`auth_secret` live on that table in plaintext, and RLS is row-level,
-- not column-level. A policy that lets a supervisor SELECT a branch-mate's row lets them
-- SELECT that row's PIN too.
--
-- INSTEAD: a narrow security definer function returning only id/full_name/role, visible
-- for: any row when the caller is a manager, the caller's own row always, or a row in the
-- caller's own branch when the caller is a supervisor. This does not need to resolve an
-- id outside those cases (a cross-branch approver, say) — callers already treat a missing
-- entry as "unknown" and fall back to "—", same as before this existed.
--
-- Apply any time after migrate_staff_pin_payments_roles_finance.sql (current_staff_id,
-- is_supervisor_or_above). Safe to re-run.

create or replace function public.resolve_staff_identities(p_ids uuid[])
returns table (
  id uuid,
  full_name text,
  role text
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.full_name, s.role
  from public.staff s
  where s.id = any(p_ids)
    and (
      public.is_manager()
      or s.id = public.current_staff_id()
      or (public.is_supervisor_or_above() and s.branch_id = public.current_staff_branch())
    );
$$;

grant execute on function public.resolve_staff_identities(uuid[]) to authenticated;

-- Verify
--   as a supervisor: select * from public.resolve_staff_identities(array[<a cashier id on your branch>]);
--   confirm the leak is closed:
--     select login_pin from public.staff;   -- must still return only your own row
