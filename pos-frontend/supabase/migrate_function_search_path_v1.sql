-- Pin search_path on public functions that Supabase advisors flag as mutable.
--
-- WHY: without SET search_path, a function resolves unqualified names using the
-- caller's path. That is a real hijack vector on SECURITY DEFINER RPCs; these
-- nine are INVOKER helpers/triggers, but pinning them still closes the advisor
-- warning and matches the convention already used by the rest of the RPC set.
-- ALTER FUNCTION does not rewrite bodies, so trigger bindings stay intact.
--
-- Apply any time after migrate_product_code.sql, migrate_bir_pos_compliance.sql,
-- migrate_cash_movements.sql / migrate_cash_movement_cash_in.sql, and
-- migrate_realtime_broadcast_v1.sql. Safe to re-run. Skips names that do not
-- exist on older environments.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as ident
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'assign_product_no',
        'cash_movement_counts',
        'cash_movement_type_allowed',
        'guard_transaction_updates',
        'prevent_transaction_item_mutation',
        'realtime_pos_is_network_ops',
        'realtime_pos_topic_branch_id',
        'tg_branch_inventory_bump_version',
        'touch_cash_movement_updated_at'
      )
  loop
    execute format('alter function %s set search_path = public', r.ident);
  end loop;
end $$;

-- Verify (expect 0 rows):
--   select p.proname
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--     and p.proname in (
--       'assign_product_no',
--       'cash_movement_counts',
--       'cash_movement_type_allowed',
--       'guard_transaction_updates',
--       'prevent_transaction_item_mutation',
--       'realtime_pos_is_network_ops',
--       'realtime_pos_topic_branch_id',
--       'tg_branch_inventory_bump_version',
--       'touch_cash_movement_updated_at'
--     )
--     and (p.proconfig is null
--          or not exists (
--            select 1 from unnest(p.proconfig) c where c like 'search_path=%'
--          ));
