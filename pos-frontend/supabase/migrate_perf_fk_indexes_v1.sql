-- Drop duplicate indexes, add hot-path FK indexes, wrap auth.uid() for RLS initplan.
--
-- WHY: advisors flagged an identical unique index on transactions (cleanup v1 was
-- supposed to drop uq_transactions_branch_client_id; it is still present — likely
-- recreated by a later re-run of migrate_sale_dedupe_hardening.sql). products also
-- has non-unique (branch_id, sku/barcode) indexes that duplicate the unique keys.
-- Four FKs on growing tables have no leading index. Two policies re-evaluate
-- auth.uid() per row instead of once via (select auth.uid()).
--
-- Access rules are unchanged: wrapping auth.uid() in a subquery is the documented
-- RLS initplan pattern, not a wider policy.
--
-- Apply after migrate_schema_cleanup_v1.sql, migrate_perf_indexes_hot_tables.sql,
-- migrate_till_action_requests.sql, and migrate_refund_sale_items.sql.
-- Safe to re-run. Demo-sized tables: plain CREATE INDEX (not CONCURRENTLY) so the
-- whole file can paste as one shot. On a live till during hours, recreate the
-- CREATE INDEX lines with CONCURRENTLY and run them individually.

-- ---------------------------------------------------------------------------
-- 1) Duplicate indexes
-- ---------------------------------------------------------------------------
-- Keep uq_transactions_branch_client (older name from migrate_bir_pos_compliance.sql).
drop index if exists public.uq_transactions_branch_client_id;

-- Unique constraints already cover (branch_id, sku) and (branch_id, barcode).
drop index if exists public.idx_products_sku;
drop index if exists public.idx_products_barcode;

-- ---------------------------------------------------------------------------
-- 2) Hot FK indexes (leading column = the unindexed FK)
-- ---------------------------------------------------------------------------
create index if not exists idx_transaction_items_product
  on public.transaction_items (product_id);

create index if not exists idx_audit_events_branch
  on public.audit_events (branch_id, created_at desc);

create index if not exists idx_sale_refund_lines_branch
  on public.sale_refund_lines (branch_id);

create index if not exists idx_till_action_requests_requested_by
  on public.till_action_requests (requested_by);

create index if not exists idx_till_action_requests_resolved_by
  on public.till_action_requests (resolved_by);

-- ---------------------------------------------------------------------------
-- 3) RLS initplan — evaluate auth.uid() once per query
-- ---------------------------------------------------------------------------
drop policy if exists "read staff" on public.staff;
create policy "read staff" on public.staff
  for select to authenticated
  using (auth_user_id = (select auth.uid()) or public.is_manager());

drop policy if exists "read audit events" on public.audit_events;
create policy "read audit events" on public.audit_events
  for select to authenticated
  using (
    public.is_manager()
    or staff_id = (
      select id from public.staff
      where auth_user_id = (select auth.uid()) and is_active
      limit 1
    )
  );
