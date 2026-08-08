-- Least-privilege hardening for role grants. Run once; safe to re-run.
--
-- Two findings from audit_security.sql, of very different severity. Read both before
-- running so you know what is actually being fixed.

-- ============================================================================
-- 1. REAL, EXPLOITABLE: the PIN lockout could be reset by the attacker.
-- ============================================================================
-- migrate_pin_security_hardening.sql locks an account after 5 failed PIN attempts for
-- 15 minutes, tracked in pin_login_attempts. resolve_pin_login() clears that counter on a
-- SUCCESSFUL login by calling clear_pin_login_failures().
--
-- But clear_pin_login_failures(text) is a plain public function, and Postgres grants
-- EXECUTE on functions to PUBLIC by default. No migration ever revoked it. So anyone
-- holding the publishable key — which ships in the frontend bundle and is not a secret —
-- can call it directly:
--
--     POST /rest/v1/rpc/clear_pin_login_failures  { "p_login_code": "CASHIER01" }
--
-- Interleave that between guesses and the lockout never triggers. A 4–6 digit PIN with
-- no effective rate limit is brute-forceable, and PIN login is how cashiers and
-- supervisors authenticate — including for supervisor overrides on voids and price
-- changes.
--
-- Fix: it is an internal helper. resolve_pin_login() and verify_supervisor_pin() are
-- SECURITY DEFINER, so they keep working after this revoke — a definer function runs as
-- its owner and can call it regardless of the caller's own privileges.

revoke execute on function public.clear_pin_login_failures(text) from public, anon, authenticated;

-- record_pin_login_failure is the counterpart: callable only from inside the login flow.
-- Leaving it exposed lets anyone lock out a colleague by login code (denial of service).
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_pin_login_failure'
  ) then
    execute 'revoke execute on function public.record_pin_login_failure(text) from public, anon, authenticated';
  end if;
exception when others then
  raise notice 'record_pin_login_failure revoke skipped (signature differs): %', sqlerrm;
end $$;

-- resolve_pin_login MUST stay anon-callable — it is the pre-login entry point.
-- Re-asserted here so a future blanket revoke does not silently break sign-in.
grant execute on function public.resolve_pin_login(text, text) to anon, authenticated;

-- ============================================================================
-- 2. DEFENCE IN DEPTH: the ~100 "anon can write" rows are Supabase's default.
-- ============================================================================
-- Supabase bootstraps every project with GRANT ALL ON ALL TABLES to anon and
-- authenticated, then relies on RLS for actual access control. So those rows are NOT an
-- open door today:
--
--   * All 24 tables have RLS enabled (confirmed by the audit).
--   * Every policy targets `to authenticated`, so anon matches none of them.
--   * PostgREST only exposes SELECT/INSERT/UPDATE/DELETE, all of which RLS gates.
--
-- The one privilege that genuinely worries me is TRUNCATE: Postgres does NOT apply row
-- security to TRUNCATE. It is not reachable through PostgREST today, so this is a latent
-- risk rather than a live hole — but a table-level grant that RLS cannot restrain, held by
-- the pre-login role, on tables holding immutable fiscal records, is not worth keeping for
-- convenience. Revoking costs nothing: the app never touches the database as anon beyond
-- the sign-in RPCs above.

revoke insert, update, delete, truncate on all tables in schema public from anon;

-- Keep anon's SELECT: RLS still gates it, and revoking risks breaking the login screen's
-- pre-auth reads. Tighten it separately only if the audit shows a policy exposing rows
-- to anon.

-- Future tables should inherit the same posture rather than depending on someone
-- remembering to re-run this file.
alter default privileges in schema public
  revoke insert, update, delete, truncate on tables from anon;

-- ============================================================================
-- Verify
-- ============================================================================
do $$
declare
  v_anon_writes integer;
  v_pin_open boolean;
begin
  select count(*) into v_anon_writes
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');

  select has_function_privilege('anon', 'public.clear_pin_login_failures(text)', 'EXECUTE')
    into v_pin_open;

  raise notice 'anon write grants remaining: % (expect 0)', v_anon_writes;
  raise notice 'clear_pin_login_failures callable by anon: % (expect false)', v_pin_open;
end $$;
