-- Attach the existing ops-broadcast trigger to `transactions` so a new sale, void, or
-- refund pushes OPERATIONS_CHANGED on pos:branch:<id>:operations immediately, instead of
-- only surfacing on the next 15s poll (`useBranchOperationsLive`, Shell.jsx).
--
-- WHY
-- ---
-- migrate_realtime_broadcast_v1.sql attached tg_ops_broadcast() to day_ends, cash_movements,
-- cash_drawer_entries, refund_requests, till_action_requests, staff_shifts, promo_events —
-- but never to transactions itself. Every other operational table pushes live; a new sale
-- rung at one terminal only reached Transactions.jsx (and any other open tab reading
-- useInventoryStore.transactions) via the 15s poll fallback, which read as "delayed".
--
-- No new topic/payload shape: reuses tg_ops_broadcast() (kind='transactions', op=INSERT/
-- UPDATE/DELETE) exactly like every other table on this trigger. Client-side, Shell.jsx's
-- useBranchOperationsLive already refetches bootstrapBranchActivity into useInventoryStore
-- on OPERATIONS_CHANGED — no frontend change needed, this migration alone closes the gap.
--
-- Prerequisite: migrate_realtime_broadcast_v1.sql (tg_ops_broadcast()).
-- Safe to re-run.

do $$
begin
  if to_regproc('public.tg_ops_broadcast') is null then
    raise exception 'tg_ops_broadcast() is missing — apply migrate_realtime_broadcast_v1.sql first';
  end if;
end $$;

drop trigger if exists trg_transactions_ops_broadcast on public.transactions;
create trigger trg_transactions_ops_broadcast
  after insert or update or delete on public.transactions
  for each row execute function public.tg_ops_broadcast();
