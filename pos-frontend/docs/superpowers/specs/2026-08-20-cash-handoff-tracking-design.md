# Cash handoff tracking — design spec

Date: 2026-08-20
Status: approved for planning

## Problem

Two related gaps:

1. **`ShiftGate.jsx`'s "Handover" notice is wired to the wrong condition.** Today it only
   renders inside `needsFreshCount` (the manager-reopened-day fresh-count case), so it
   pops up exactly when it shouldn't (the cashier who reopens/starts after a manager
   reopen never actually held the previous drawer's cash — that cash was already handed
   to the supervisor at the prior close) and never pops up when it should (an ordinary
   cashier-to-cashier turnover on the same drawer, mid-week or mid-day).
2. **There is no manager-level cash handoff tracking.** A supervisor closes a day (counts
   the drawer, submits, day auto-closes) and then, at some later point — sometimes same
   day, sometimes days later for a far branch — physically hands that day's cash to a
   manager. Nothing today records whether/when the manager actually received it, and
   nothing surfaces cashier→supervisor handoff history in reports either.

## Scope

- Fix `ShiftGate.jsx`'s Handover notice condition (informational only, no new mandatory
  count — day-end remains the single mandatory cash count per business day).
- Add supervisor→manager handoff confirmation: non-blocking, no deadline, manager
  confirms whenever the cash physically arrives. Does not gate Close day, does not gate
  anything else — pure record-keeping.
- Add a "Handoffs" tab inside the per-branch Manager view (`BranchDashboard.jsx`) showing
  both handoff kinds (cashier→supervisor read-only history, supervisor→manager with
  per-row confirm).
- Cashier→supervisor handoff mechanics (`receive_shift_handoff` RPC, the supervisor's
  Day End "Confirm received handoff" button) are **unchanged** — the user confirmed this
  stays a single per-day confirm-all action. It only gains a read-only report surface.

Out of scope: any change to Close day / Submit day / Approve day gating; any change to
the cashier End Shift flow; any new offline queue type (this feature is manager-only and
already lives in BranchDashboard's existing network-only data path).

## A. Data model

No schema change for cashier→supervisor — already fully tracked via `staff_shifts`
(`ending_cash`, `expected_cash`, `variance`, `clock_out`) plus the `shift_adjustments` row
`receive_shift_handoff()` writes (`field='ending_cash'`, `adjusted_by`/`approved_by` = the
receiving supervisor, `created_at` = when).

New for supervisor→manager, via `migrate_day_end_cash_handoff.sql`:

```sql
alter table day_ends
  add column handoff_confirmed_by uuid references staff(id) on delete set null,
  add column handoff_confirmed_at timestamptz;

create or replace function public.confirm_day_end_handoff(p_day_end_id uuid)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends%rowtype;
begin
  if not public.is_manager() then
    raise exception 'DAYEND_NOT_ALLOWED: only a manager can confirm a cash handoff';
  end if;

  select * into v_row from public.day_ends where id = p_day_end_id for update;
  if not found then
    raise exception 'DAYEND_NOT_FOUND: no day-end with id %', p_day_end_id;
  end if;

  if v_row.status <> 'closed' then
    raise exception 'DAYEND_NOT_CLOSED: only a closed day can have its cash handoff confirmed';
  end if;

  -- Idempotent: re-confirming an already-confirmed row is a no-op success, same
  -- pattern as receive_shift_handoff's early return.
  if v_row.handoff_confirmed_at is not null then
    return v_row;
  end if;

  update public.day_ends
  set handoff_confirmed_by = public.current_staff_id(),
      handoff_confirmed_at = now()
  where id = p_day_end_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.confirm_day_end_handoff(uuid) from public, anon;
grant execute on function public.confirm_day_end_handoff(uuid) to authenticated;
```

RLS: existing `day_ends` policies already scope manager access network-wide via
`is_manager()`; no new policy needed since this is a function-gated update, not a direct
table grant.

## B. `ShiftGate.jsx` fix

Current (`src/components/shared/ShiftGate.jsx`):
- `needsFreshCount = holdsDrawer && todayEntry?.status === 'reopened'` — gates BOTH the
  mandatory fresh-count form AND (wrongly) the Handover notice box.
- Ordinary turnover (`autoStarting`) is silent — no UI at all, so the Handover box never
  shows for a plain cashier-to-cashier handoff even when `carried` (the previous shift's
  counted `endingCash`) is available.

Change:
- `needsFreshCount` stays exactly as-is (reopen-only, mandatory count) but its rendered
  block **drops** the Handover box entirely — a reopened day starts clean, no reference
  to a prior figure, per the "cashier shouldn't have it anymore, they already gave it to
  the supervisor" rule.
- New `showHandoverNotice = holdsDrawer && carried != null && !needsFreshCount`.
- `autoStarting` gains `&& !showHandoverNotice` to its condition — so when a carried
  figure exists on ordinary turnover, the silent auto-start is skipped in favor of a new
  lightweight modal: Handover box (same copy as today's, staff name + amount) plus a
  plain "Start shift" button. No amount field, no checkbox, no forced recount — this is
  an FYI/acknowledgment step only. Clicking Start shift calls `doStart({ startingCash: 0 })`
  same as the current silent path.
- `carried` continues to come from `handoff?.endingCash`, which is `null` until a
  supervisor has run `receive_shift_handoff` for the previous shift — so this notice
  naturally only appears once that confirmation has happened, same data source as today,
  just gated correctly.

## C. Manager Handoffs tab

`src/pages/manager/BranchDashboard.jsx` gains a top-level `Tabs` (same component already
used for `invTab`), state `mainTab` = `'overview' | 'handoffs'`, default `'overview'`.
All existing JSX in the component's return is wrapped under the `'overview'` branch,
unchanged. A new `'handoffs'` branch renders a new component,
`src/components/dayend/BranchHandoffs.jsx`.

**No new bootstrap/fetch functions needed** — `BranchDashboard.jsx` already loads
everything the panel needs:
- `data.dayEnds` (`bootstrapBranchData` → `bootstrapBranchActivity`, 90-day cutoff)
  already carries every closed day for this branch. Extending `BOOTSTRAP_DAY_END_COLS`
  and `mapDayEndRow` with the two new columns (plus a `confirmer:staff!handoff_confirmed_by(full_name)`
  embed for display) means `data.dayEnds` carries `handoffConfirmedBy`/
  `handoffConfirmedByName`/`handoffConfirmedAt` for free, no new query.
- `staffShifts` state (`fetchStaffShifts({ branchId, ... })`, 30-day window, already
  fetched for the Staff/hours section) already carries every drawer shift for this
  branch with `holdsDrawer`/`open`/`endingCash`/`staffName`/`businessDate` — exactly
  what the cashier→supervisor list needs, filtered client-side
  (`holdsDrawer && !open && endingCash != null`).
- Who received each of those and when comes from the existing exported
  `fetchShiftAdjustments(shiftIds)` (already used by `DayEnd.jsx`) — `BranchHandoffs.jsx`
  calls it itself, scoped to the filtered shift ids, in its own effect.

`BranchHandoffs.jsx` receives `dayEnds`, `staffShifts`, `branchId`, `user`, `onReload` as
props and renders two read/act sections:

1. **Cashier → supervisor** (read-only): staff name, business date, amount
   (`endingCash`), received-by/received-at from `fetchShiftAdjustments`. No action —
   already-confirmed by construction (only received shifts have `ending_cash` set).

2. **Supervisor → manager**: `dayEnds` rows with `status === 'closed'`, newest first,
   checkbox per unconfirmed row (confirmed rows show name/time instead, matching the
   existing DrawerActivity/Received-handoff visual pattern in `DayEnd.jsx`). "Confirm
   received (N)" button loops selected ids through the one new API call,
   `confirmDayEndHandoff(id)`, same loop-and-reload shape as `receiveAllHandoffs` in
   `DayEnd.jsx`, then calls `onReload()`. Selecting 1 row confirms a single day;
   selecting several confirms a week's worth in one action — no separate day/week
   toggle needed.

Only one new `api.js` export: `confirmDayEndHandoff`. Manager-only, direct Supabase RPC
call (no offline queue, no Dexie mirror) — consistent with the rest of
`BranchDashboard.jsx`'s existing network-only sections.

## Error handling / edge cases

- `confirm_day_end_handoff` on a non-closed day → `DAYEND_NOT_CLOSED`, surfaced via
  `formatSupportError` with new error code `TILL05` (next free code in the `TILL` family,
  `src/utils/errors.js` — `TILL01`–`TILL04` already used).
- Re-confirming an already-confirmed row is a no-op success (idempotent), matching
  `receive_shift_handoff`'s own idempotency — the UI simply won't offer a checkbox for
  an already-confirmed row, so double-confirm can only happen via a stale list; the RPC
  absorbs that safely.
- Offline: the Handoffs tab (like the rest of `BranchDashboard`) requires connectivity —
  no offline fallback needed, matching existing manager-dashboard behavior elsewhere on
  this page.
- `ShiftGate`'s new modal: if `doStart` fails (network/local write error), same existing
  error banner + retry pattern as every other branch in this component — no new error
  path needed.

## Testing / verification

- `npm run lint`, `npm run build`.
- Manual, `npm run dev`:
  - Manager reopens a closed day → next shift start on that drawer shows the blank
    fresh-count form, **no** Handover box.
  - Cashier A ends shift (drawer, no reopen involved) → supervisor confirms received
    handoff at Day End (unchanged flow) → Cashier B signs in on the same drawer → sees
    the new Handover acknowledgment modal with A's name/amount, taps Start shift, shift
    opens at ₱0 change fund (unchanged financial behavior, only the notice is new).
  - Manager opens a branch, switches to Handoffs tab: sees cashier→supervisor history
    (read-only) and a checkbox list of closed days; selects 2, confirms; both flip to
    confirmed with manager's name/time; reload persists the state.
- No new automated tests exist in this repo (project has none); verification is
  lint/build/manual per `CLAUDE.md`.

## Docs / versioning

- `CODEMAP.md`: update the Day End / shift-handoff section to describe the corrected
  `ShiftGate` condition, and add a short "Cash handoffs" entry (data model + report
  location) near the Day End / BranchDashboard documentation.
- `package.json` version: MINOR bump (new capability, no existing behavior changes
  beyond the bug fix, which is itself a correction of unshipped/mismatched behavior).
- `CHANGELOG.md`: entry for both the Handover-notice fix and the new Handoffs tracking.
