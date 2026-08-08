-- Follow-up drill-down for section 4 of audit_security.sql. READ-ONLY.
--
-- That section's heuristic was crude: it flagged every SECURITY DEFINER function whose body
-- lacked is_manager() / current_staff_branch() / raise exception. That over-reports badly,
-- because two large groups are safe by construction:
--
--   * TRIGGER functions — not callable over RPC at all. They only ever run because the
--     database fired them, so "no auth check" is irrelevant.
--   * The auth primitives themselves (current_staff_id, current_staff_role,
--     is_supervisor_or_above) — they read auth.uid() and return facts about the CALLER.
--     There is nothing to escalate to.
--
-- What actually matters is the third group: functions that are DIRECTLY CALLABLE over RPC
-- by anon or authenticated, run as owner, and change data. This query isolates those.
--
-- Paste into the Supabase SQL editor and run.

select
  p.proname as function_name,
  case
    when p.prorettype = 'trigger'::regtype then 'TRIGGER — not callable over RPC'
    when has_function_privilege('anon', p.oid, 'EXECUTE')
      then '*** CALLABLE BY ANON (pre-login) ***'
    when has_function_privilege('authenticated', p.oid, 'EXECUTE')
      then 'callable by any signed-in user'
    else 'not granted to anon/authenticated'
  end as exposure,
  case
    when p.provolatile = 'v' then 'writes/volatile'
    else 'read-only'
  end as volatility,
  pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
order by
  -- Worst first: callable by anon, then by any user, then triggers.
  case
    when p.prorettype = 'trigger'::regtype then 3
    when has_function_privilege('anon', p.oid, 'EXECUTE') then 0
    when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 1
    else 2
  end,
  p.proname;

-- Anything showing "CALLABLE BY ANON" that also writes needs its body read closely.
-- Expected legitimate cases: the PIN login flow must work before sign-in, so
-- resolve_pin_login / record_pin_login_failure are intentionally anon-callable.
--
-- The one to check hardest is clear_pin_login_failures: if an attacker can call it
-- directly, they can reset their own lockout counter between guesses and the
-- 5-attempts-per-15-minutes protection stops meaning anything.
