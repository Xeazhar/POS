-- CRITICAL: close an unauthenticated bypass on the core sale/inventory/OR RPCs.
--
-- WHY
-- ---
-- Postgres grants EXECUTE on every new function to PUBLIC by default. None of these five
-- migrations ever revoked it, so the `anon` role -- i.e. the publishable/anon key, which
-- ships in the frontend bundle and is not a secret -- can call every one of these directly
-- via PostgREST with no login at all:
--
--   allocate_or_number(uuid)                           -- migrate_bir_pos_compliance.sql
--   reserve_or_number(uuid, text)                       -- migrate_offline_or_reserve.sql
--   void_sale_secure(uuid, uuid, text, uuid)            -- migrate_void_sale_approved_by.sql
--   refund_sale_items(uuid, uuid, text, jsonb, uuid)    -- migrate_fix_refund_sale_items_typo.sql
--   record_stock_movement(uuid, uuid, uuid, text, numeric, numeric, text, text)
--                                                        -- migrate_sale_stock_update.sql
--
-- allocate_or_number, reserve_or_number, void_sale_secure, and refund_sale_items have NO
-- branch/staff authorization check in their bodies at all -- they are SECURITY DEFINER, so
-- they bypass RLS by design and rely entirely on the grant to keep non-staff callers out.
-- record_stock_movement does have a check (`if p_branch_id <> current_staff_branch() and
-- not is_manager()`), but it is NULL-unsafe: an anon caller has no matching staff row, so
-- current_staff_branch() returns NULL, `NULL <> p_branch_id` evaluates to NULL (not true),
-- and the `if` never raises.
--
-- Net effect as deployed: anyone holding the public anon key could void or refund any sale,
-- allocate/burn OR numbers, or move inventory on any branch, with no login, no PIN, nothing.
-- This affects every environment built from these migrations (POS-Stress test, CalePOS_Demo,
-- and any future production project), not just this one.
--
-- FIX
-- ---
-- Revoke the PUBLIC/anon default grant, same pattern already used for other RPCs in this
-- schema (migrate_harden_grants.sql, migrate_shift_cash_accountability.sql,
-- migrate_realtime_broadcast_v1.sql). `authenticated` keeps its own explicit grant from each
-- function's origin migration, so real logged-in staff/managers see zero behavior change --
-- this only removes the door that was never supposed to be open. The record_stock_movement
-- NULL-unsafe check is a separate, lower-urgency follow-up (defense in depth once this grant
-- fix already closes the door); not touched here to keep this patch minimal and safe.
--
-- Safe to re-run.

revoke all on function public.allocate_or_number(uuid) from public, anon;
revoke all on function public.reserve_or_number(uuid, text) from public, anon;
revoke all on function public.void_sale_secure(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.refund_sale_items(uuid, uuid, text, jsonb, uuid) from public, anon;
revoke all on function public.record_stock_movement(uuid, uuid, uuid, text, numeric, numeric, text, text) from public, anon;

-- Verify
do $$
declare
  v_anon_alloc boolean;
  v_anon_reserve boolean;
  v_anon_void boolean;
  v_anon_refund boolean;
  v_anon_stock boolean;
  v_auth_alloc boolean;
begin
  select has_function_privilege('anon', 'public.allocate_or_number(uuid)', 'EXECUTE') into v_anon_alloc;
  select has_function_privilege('anon', 'public.reserve_or_number(uuid, text)', 'EXECUTE') into v_anon_reserve;
  select has_function_privilege('anon', 'public.void_sale_secure(uuid, uuid, text, uuid)', 'EXECUTE') into v_anon_void;
  select has_function_privilege('anon', 'public.refund_sale_items(uuid, uuid, text, jsonb, uuid)', 'EXECUTE') into v_anon_refund;
  select has_function_privilege('anon', 'public.record_stock_movement(uuid, uuid, uuid, text, numeric, numeric, text, text)', 'EXECUTE') into v_anon_stock;
  select has_function_privilege('authenticated', 'public.allocate_or_number(uuid)', 'EXECUTE') into v_auth_alloc;

  raise notice 'anon allocate_or_number: % (expect false)', v_anon_alloc;
  raise notice 'anon reserve_or_number: % (expect false)', v_anon_reserve;
  raise notice 'anon void_sale_secure: % (expect false)', v_anon_void;
  raise notice 'anon refund_sale_items: % (expect false)', v_anon_refund;
  raise notice 'anon record_stock_movement: % (expect false)', v_anon_stock;
  raise notice 'authenticated allocate_or_number: % (expect true)', v_auth_alloc;
end $$;
