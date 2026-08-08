-- Make offline-sale replay idempotent at the DATABASE level.
--
-- WHY: api.completeSale de-duplicates by SELECTing on client_id and inserting only if it
-- finds nothing. That is check-then-act with no lock, so two pushes of the same queued sale
-- that overlap — a retry firing while the first attempt is still in flight, two tabs on the
-- same terminal, a reconnect racing the interval sync — can both see "not found" and both
-- insert. Result: the sale is recorded twice, two OR numbers are consumed, revenue and the
-- stock decrement are doubled, and because sale rows are immutable by design the correction
-- has to be a void with a paper trail.
--
-- The application check is a fast path; this index is the actual guarantee. Postgres will
-- reject the second insert, completeSale's existing "already exists" path handles it, and
-- the queue item completes normally.
--
-- Run once. Safe to re-run.

-- Partial: legacy rows created before client_id existed are NULL, and NULLs would otherwise
-- be exempt anyway — being explicit documents the intent and keeps the index small.
create unique index if not exists uq_transactions_branch_client_id
  on transactions (branch_id, client_id)
  where client_id is not null;

-- Same exposure on stock movements replayed from the queue.
create index if not exists idx_stock_movements_branch_created
  on stock_movements (branch_id, created_at desc);

-- Surface any duplicates that already landed before this index existed, so they can be
-- voided deliberately rather than discovered during a BIR review.
do $$
declare
  v_dupes integer;
begin
  select count(*) into v_dupes
  from (
    select branch_id, client_id
    from transactions
    where client_id is not null
    group by branch_id, client_id
    having count(*) > 1
  ) d;

  if v_dupes > 0 then
    raise warning 'DUPLICATE SALES FOUND: % client_id group(s) have more than one transaction row. The unique index above could not be created until these are resolved. Query them with: select branch_id, client_id, count(*), array_agg(or_number) from transactions where client_id is not null group by 1,2 having count(*) > 1;', v_dupes;
  else
    raise notice 'No duplicate sales found — dedupe index is now enforced.';
  end if;
end $$;
