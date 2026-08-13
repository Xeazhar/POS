-- Revoke client EXECUTE on internal SECURITY DEFINER helpers.
--
-- WHY: Postgres grants EXECUTE to PUBLIC by default. PostgREST exposes any function
-- authenticated can execute. apply_counted_cash_movement_effects() is only meant to run
-- via PERFORM from create/approve cash-movement RPCs — not as a direct RPC. Without this
-- revoke, audit_security.sql §4 flags it CRITICAL and a caller could pass a crafted
-- cash_movements row to bump starting_cash on any shift id.
--
-- SECURITY DEFINER callers (create_cash_movement_approved, etc.) keep working — they run
-- as the function owner and retain execute rights.
--
-- Apply after migrate_cash_movement_cash_in.sql. Safe to re-run.

do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'apply_counted_cash_movement_effects'
  ) then
    execute $rev$
      revoke execute on function public.apply_counted_cash_movement_effects(public.cash_movements)
      from public, anon, authenticated
    $rev$;
  end if;

  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'validate_cash_movement_opening_float'
  ) then
    execute $rev$
      revoke execute on function public.validate_cash_movement_opening_float(uuid, text)
      from public, anon, authenticated
    $rev$;
  end if;
exception when others then
  raise notice 'cash movement internal revoke skipped: %', sqlerrm;
end $$;

-- Verify (expect false):
--   select has_function_privilege(
--     'authenticated',
--     'public.apply_counted_cash_movement_effects(public.cash_movements)',
--     'EXECUTE'
--   );

notify pgrst, 'reload schema';
