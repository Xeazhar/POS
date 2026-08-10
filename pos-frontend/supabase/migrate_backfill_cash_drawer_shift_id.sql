-- Backfill cash_drawer_entries.shift_id on rows that were written without one.
--
-- WHY
-- ---
-- Petty-cash and pickup entries are deducted from expected drawer cash in two places that
-- scope differently:
--   * shift_cash_summary()  — the cashier's "End shift" total — filters strictly on
--     `shift_id = <this shift>`.
--   * DayEnd.jsx (supervisor) — sums every entry for the BUSINESS DATE, unscoped by shift.
--
-- So an entry with `shift_id is null` is deducted from the supervisor's expected drawer but
-- NOT from the cashier's, and the two screens disagree by exactly that amount. Observed:
-- a ₱450.00 fulfilled "Water delivery" paid-out with a null shift_id put the cashier at
-- ₱1,883.90 and the supervisor at ₱1,433.90 on the same single-shift drawer.
--
-- Two frontend bugs produced these rows; both are already fixed, so this is a one-off
-- cleanup of history, not a recurring patch:
--   * SupervisorDayEnd's pickup form and its PettyCashPanel passed the VIEWING supervisor's
--     own shift (`activeShift`), which is null for a supervisor not holding a drawer. Now
--     attributes to the shift actually holding the drawer.
--   * The cashier's own panel read `shift.serverId` off a live store object that was never
--     refreshed after the shift's OPEN_SHIFT push landed, so it could still be null minutes
--     later. Now resolved through useShiftStore.syncShiftServerId().
--
-- transactions.shift_id is deliberately NOT backfilled here: guard_transaction_updates()
-- (migrate_bir_pos_compliance.sql) rejects every update to a sale except a void transition,
-- and that immutability is the point of the control. A sale that reached the server with a
-- null shift_id stays unattributed — see the report at the bottom of this file.
--
-- SAFETY: only ever fills a NULL. Never moves an entry already attributed to a shift.
-- Nothing here changes an amount, a status, or an approval — only shift attribution.
--
-- WHY THE CONSTRAINT IS DROPPED AND RE-ADDED
-- -----------------------------------------
-- cash_drawer_entries_fulfil_needs_approval is permanently NOT VALID
-- (migrate_petty_cash_fulfilment.sql): pre-workflow rows are `fulfilled` with a null
-- approver and are deliberately tolerated. But NOT VALID only skips the one-off scan of
-- existing rows — it does NOT exempt an UPDATE. Touching such a legacy row for ANY reason
-- re-checks it and fails:
--   ERROR: new row for relation "cash_drawer_entries" violates check constraint
--          "cash_drawer_entries_fulfil_needs_approval"
-- and because the whole script is one transaction, that one row aborts the entire backfill.
--
-- So the constraint is dropped, the attribution is written, and the constraint is re-added
-- byte-identical and still NOT VALID. Net effect on the control: none. It protects exactly
-- what it protected before (every future insert/update), and the legacy rows stay exactly as
-- they were — still fulfilled, still without an approver, never back-filled with a sign-off
-- that never happened. This is the same drop → write → re-add sequence
-- migrate_petty_cash_fulfilment.sql used for its own backfill, for the same reason.
--
-- ---------------------------------------------------------------------------
-- DRY RUN FIRST — run this on its own and read the result before running the file:
-- ---------------------------------------------------------------------------
--   select c.id, c.business_date, c.kind, c.status, c.amount, left(c.reason, 40) as reason,
--          s.id as would_attach_to, s.staff_id, s.drawer_id, s.clock_in, s.clock_out
--   from public.cash_drawer_entries c
--   left join public.staff_shifts s
--     on s.branch_id = c.branch_id and s.holds_drawer
--    and s.clock_in <= c.created_at
--    and (s.clock_out is null or s.clock_out >= c.created_at)
--   where c.shift_id is null
--   order by c.created_at desc;
--
-- Safe to re-run (idempotent: after a successful run there is nothing left matching).

-- ---------------------------------------------------------------------------
-- Lift the fulfilment check for the duration of this transaction. See the header.
-- Re-added identically at the end; if anything below fails the whole script rolls back,
-- constraint included, so it can never be left off.
-- ---------------------------------------------------------------------------
alter table public.cash_drawer_entries
  drop constraint if exists cash_drawer_entries_fulfil_needs_approval;

-- ---------------------------------------------------------------------------
-- Pass A — the entry was recorded WHILE exactly one drawer shift was open.
-- ---------------------------------------------------------------------------
-- Strongest signal available: the cash physically left the drawer during that shift, so
-- that shift is accountable for it. Requires exactly one candidate, so a moment when two
-- drawer shifts somehow overlapped is left alone rather than guessed at.
update public.cash_drawer_entries c
set shift_id = s.id
from public.staff_shifts s
where c.shift_id is null
  and s.branch_id = c.branch_id
  and s.holds_drawer
  and s.clock_in <= c.created_at
  and (s.clock_out is null or s.clock_out >= c.created_at)
  and (
    select count(*)
    from public.staff_shifts s2
    where s2.branch_id = c.branch_id
      and s2.holds_drawer
      and s2.clock_in <= c.created_at
      and (s2.clock_out is null or s2.clock_out >= c.created_at)
  ) = 1;

-- ---------------------------------------------------------------------------
-- Pass B — no shift was open at that instant, but the business date had exactly one.
-- ---------------------------------------------------------------------------
-- Covers an entry recorded just before the cashier clocked in or just after they clocked
-- out. With a single drawer shift on that business date there is only one cashier it can
-- belong to, so this is unambiguous rather than a guess. Days with two or more drawer
-- shifts are deliberately skipped — attributing to the wrong one would move a shortage onto
-- the wrong person, which is worse than leaving it day-scoped.
update public.cash_drawer_entries c
set shift_id = s.id
from public.staff_shifts s
where c.shift_id is null
  and s.branch_id = c.branch_id
  and s.holds_drawer
  and s.business_date = c.business_date
  and (
    select count(*)
    from public.staff_shifts s2
    where s2.branch_id = c.branch_id
      and s2.holds_drawer
      and s2.business_date = c.business_date
  ) = 1;

-- ---------------------------------------------------------------------------
-- Restore the control — byte-identical to migrate_petty_cash_fulfilment.sql, still NOT
-- VALID for the same reason (historical rows predate the approve step and must not be
-- rewritten to satisfy a rule that postdates them).
-- ---------------------------------------------------------------------------
alter table public.cash_drawer_entries
  add constraint cash_drawer_entries_fulfil_needs_approval
  check (
    status <> 'fulfilled'
    or (approved_by is not null and approved_at is not null)
  )
  not valid;

-- Fail loudly if the constraint did not come back, rather than leaving the database with a
-- fiscal control silently missing.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'cash_drawer_entries_fulfil_needs_approval'
      and conrelid = 'public.cash_drawer_entries'::regclass
  ) then
    raise exception 'cash_drawer_entries_fulfil_needs_approval was not restored — do not leave the database in this state';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Report — what is left, and why
-- ---------------------------------------------------------------------------
-- Anything still null needs a human decision (two or more drawer shifts that day, or no
-- drawer shift at all). These stay day-scoped: the supervisor's Day End still deducts them,
-- the cashier's End Shift does not.
select
  'cash_drawer_entries still unattributed' as note,
  c.id, c.business_date, c.kind, c.status, c.amount, left(coalesce(c.reason, ''), 40) as reason
from public.cash_drawer_entries c
where c.shift_id is null
order by c.business_date desc, c.created_at desc;

-- Sales that reached the server with no shift attribution. NOT fixable (immutable by
-- design) — listed so the accountability gap is visible rather than silent. A sale here is
-- counted in the supervisor's day total but in no cashier's shift total.
select
  'transactions with no shift (immutable, cannot be fixed)' as note,
  t.id, t.or_number, t.created_at, t.status, t.total_amount, t.payment_method
from public.transactions t
where t.shift_id is null
order by t.created_at desc
limit 50;
