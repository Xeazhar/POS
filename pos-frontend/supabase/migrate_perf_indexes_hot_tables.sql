-- CalePOS: indexes for the tables every hot path filters/sorts by branch_id + created_at.
-- transactions, transaction_items, stock_movements, day_ends, staff_shifts had no
-- query-shaped index (only PK + a couple of unique constraints on transactions).
-- As sale volume grows this is the single biggest source of slow bootstrap/report/day-end
-- loads. Safe to re-run; CONCURRENTLY avoids locking writes on a live store during business hours.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. If your SQL editor
-- wraps statements in an implicit transaction, run each statement individually.

create index concurrently if not exists idx_transactions_branch_created
  on transactions(branch_id, created_at desc);

create index concurrently if not exists idx_transactions_staff_created
  on transactions(staff_id, created_at desc);

create index concurrently if not exists idx_transaction_items_txn
  on transaction_items(transaction_id);

create index concurrently if not exists idx_stock_movements_branch_created
  on stock_movements(branch_id, created_at desc);

create index concurrently if not exists idx_stock_movements_product
  on stock_movements(product_id);

create index concurrently if not exists idx_day_ends_branch_date
  on day_ends(branch_id, business_date desc);

create index concurrently if not exists idx_staff_shifts_branch_created
  on staff_shifts(branch_id, created_at desc);

create index concurrently if not exists idx_staff_shifts_staff
  on staff_shifts(staff_id);
