-- Enables Supabase Realtime (postgres_changes) on the tables that need to push
-- live updates to an open POS/notification screen: price/promo edits made by a
-- manager should reach the cashier immediately, and approval requests should
-- reach supervisors/managers immediately — see src/offline/realtime.js.
--
-- RLS already gates what each subscribed client actually receives (same
-- policies as normal SELECT), so this migration only turns replication on —
-- it does not change who can see what.
--
-- Safe to re-run: skips a table if it's already in the publication, and skips
-- a table name that doesn't exist yet (e.g. legacy `petty_cash` vs the
-- renamed `cash_drawer_entries`, depending on which rename migration you've run).
--
-- Deliberately NOT setting `replica identity full`: with the default (primary key),
-- a DELETE event's payload carries only the id, so a `branch_id=eq.X` filtered
-- subscription won't match deletes. That's an accepted gap — the client treats every
-- event as "go refetch" and also refetches on focus/reconnect/interval, so a deleted
-- row is picked up there instead. Turning on full replica identity would write the
-- entire old row to WAL on every UPDATE, which is real cost on branch_inventory
-- (one write per line item per sale) for a case that barely happens.

do $$
declare
  t text;
begin
  foreach t in array array[
    'products',
    'branch_inventory',
    'promo_events',
    'promo_rules',
    'promo_rule_products',
    'day_ends',
    'cash_drawer_entries',
    'petty_cash'
  ]
  loop
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = t)
      and not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      )
    then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
