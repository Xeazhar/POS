# Cash Handoff Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `ShiftGate.jsx`'s mis-wired "Handover" notice (fires on manager-reopen, never on
ordinary cashier turnover) and add non-blocking supervisor→manager cash-handoff
confirmation, with both handoff kinds surfaced in a new per-branch manager "Handoffs" tab.

**Architecture:** One new DB migration (`day_ends` gains 2 columns + a manager-only RPC).
One new API wrapper reusing existing exported helpers. One corrected condition in
`ShiftGate.jsx`. One new read/act panel component wired into a new top-level `Tabs` in
`BranchDashboard.jsx`, fed entirely by data that page already fetches — no new bootstrap
queries.

**Tech Stack:** React + Zustand + Supabase (Postgres/PostgREST/RPC), existing project
conventions (`src/components/ui`, `src/lib/api.js`, `src/utils/errors.js`).

**Spec:** `pos-frontend/docs/superpowers/specs/2026-08-20-cash-handoff-tracking-design.md`

## Global Constraints

- No offline queue / Dexie mirror for this feature — manager-only, direct Supabase calls,
  same network-only convention as the rest of `BranchDashboard.jsx`.
- Supervisor→manager confirmation is non-blocking and has no deadline — it must never gate
  Close day, Submit day, or Approve day.
- Cashier→supervisor handoff mechanics (`receive_shift_handoff`, the Day End "Confirm
  received handoff" button) are unchanged — this plan only adds a read-only report view of
  that existing data.
- `ShiftGate.jsx`'s reopened-day fresh-count path keeps asking for a count but must show
  **no** reference to a previous shift's figure.
- Every migration file needs a one-line append to `pos-frontend/supabase/README.md`'s
  apply-order list (project convention — every `migrate_*.sql` is listed there).
- Verification in this repo is `npm run lint` + `npm run build` + manual `npm run dev`
  click-through — there is no automated test suite (see `CLAUDE.md`).
- Version bump (MINOR, `0.24.1` → `0.25.0`) and `CHANGELOG.md` entry happen once, in the
  final task, only after explicit user confirmation at that point (project rule: version is
  bumped only when the user accepts it, prompted at the time — do not bump silently).

---

### Task 1: DB migration — `day_ends` handoff columns + `confirm_day_end_handoff` RPC

**Files:**
- Create: `pos-frontend/supabase/migrate_day_end_cash_handoff.sql`
- Modify: `pos-frontend/supabase/README.md:280-281` (append to the apply-order list)

**Interfaces:**
- Produces: `day_ends.handoff_confirmed_by` (uuid, nullable), `day_ends.handoff_confirmed_at`
  (timestamptz, nullable); RPC `confirm_day_end_handoff(p_day_end_id uuid) returns day_ends`
  — manager-only, idempotent, only succeeds on `status = 'closed'` rows. Task 3 (api.js)
  calls this RPC by exact name and param.

- [ ] **Step 1: Write the migration file**

```sql
-- Supervisor→manager cash handoff confirmation.
--
-- A supervisor closes a day (counts drawer, submits — day auto-closes, see
-- migrate_day_end_supervisor_autoclose.sql) and later physically hands that day's cash to
-- a manager — sometimes same day, sometimes days later for a branch that isn't close by.
-- This is deliberately NON-BLOCKING: it never gates Close day, Submit day, or Approve day.
-- A manager just confirms whenever the cash actually arrives, for record-keeping.
--
-- Prerequisite: base day_ends table + is_manager() (schema.sql / early migrations).

alter table public.day_ends
  add column if not exists handoff_confirmed_by uuid references public.staff(id) on delete set null,
  add column if not exists handoff_confirmed_at timestamptz;

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

  -- Idempotent: re-confirming an already-confirmed row is a no-op success, same pattern
  -- as receive_shift_handoff's early return.
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

- [ ] **Step 2: Append to the README apply-order list**

In `pos-frontend/supabase/README.md`, the fenced apply-order block currently ends:

```
migrate_shift_cash_summary_expose_cash_in.sql  -- needs migrate_cash_movement_cash_in.sql above;
                                                -- adds cash_in to shift_cash_summary's output so
                                                -- OwnShiftSoFar.jsx can show it as its own line
                                                -- instead of only being folded into expected_cash
```

Change the old_string above (this exact block, including the closing fence line that
follows it) to:

```
migrate_shift_cash_summary_expose_cash_in.sql  -- needs migrate_cash_movement_cash_in.sql above;
                                                -- adds cash_in to shift_cash_summary's output so
                                                -- OwnShiftSoFar.jsx can show it as its own line
                                                -- instead of only being folded into expected_cash
migrate_day_end_cash_handoff.sql               -- day_ends.handoff_confirmed_by/at +
                                                -- confirm_day_end_handoff() — manager confirms
                                                -- receiving a closed day's cash; non-blocking,
                                                -- no deadline
```

(i.e. insert the new line right before the fence, leaving everything above untouched.)

- [ ] **Step 3: Sanity-check the SQL**

No local Postgres in this repo — read the file back once and confirm: both `alter table`
columns use `if not exists` (safe to re-run), the RPC's `security definer` + `search_path`
match `receive_shift_handoff`'s shape in `migrate_receive_shift_handoff.sql`, and the
`revoke`/`grant` pair is present. This migration is applied by hand in the Supabase SQL
editor per this project's convention (`CLAUDE.md`) — do not attempt to apply it via the
Supabase MCP tools in this task.

- [ ] **Step 4: Commit**

```bash
git add pos-frontend/supabase/migrate_day_end_cash_handoff.sql pos-frontend/supabase/README.md
git commit -m "feat(db): add day_ends cash handoff confirmation"
```

---

### Task 2: New error code `TILL05`

**Files:**
- Modify: `pos-frontend/src/utils/errors.js:206-215` (right after `TILL04`, before the
  `SALE` section comment)

**Interfaces:**
- Produces: `ERROR_CATALOG.TILL05`, consumed via `appError('TILL05', raw)` /
  `formatSupportError(err, 'TILL05')` in Task 3 and Task 5.

- [ ] **Step 1: Add the catalog entry**

Current (`src/utils/errors.js:206-215`):

```js
  TILL04: {
    message:
      'Refund/void not allowed: this business day is closed. No sales or refunds until a manager reopens the till, or the next business day opens.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause:
      'assert_business_day_mutable() (or the client lock check) refused the void/refund because that sale’s business day is submitted or closed. Trading into a closed day would corrupt the Z-Read.',
    fix: 'Manager reopens the till from Day end if the same business day must stay open, otherwise wait until the next business day opens and handle the customer then.',
  },

  // ── SALE — taking money ──────────────────────────────────────────────────
```

Change to:

```js
  TILL04: {
    message:
      'Refund/void not allowed: this business day is closed. No sales or refunds until a manager reopens the till, or the next business day opens.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause:
      'assert_business_day_mutable() (or the client lock check) refused the void/refund because that sale’s business day is submitted or closed. Trading into a closed day would corrupt the Z-Read.',
    fix: 'Manager reopens the till from Day end if the same business day must stay open, otherwise wait until the next business day opens and handle the customer then.',
  },
  TILL05: {
    message: 'Could not confirm cash handoff.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause:
      'confirm_day_end_handoff() refused the request — either this day is not closed yet, the caller is not a manager, or the RPC/migration is missing (migrate_day_end_cash_handoff.sql).',
    fix: 'Only a closed day can have its handoff confirmed. Confirm the migration is applied and the account is a manager, then retry.',
  },

  // ── SALE — taking money ──────────────────────────────────────────────────
```

- [ ] **Step 2: Lint**

Run: `cd pos-frontend && npm run lint`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add pos-frontend/src/utils/errors.js
git commit -m "feat: add TILL05 error code for cash handoff confirmation"
```

---

### Task 3: `api.js` — expose handoff columns + `confirmDayEndHandoff`

**Files:**
- Modify: `pos-frontend/src/lib/api.js:21-52` (`mapDayEndRow`)
- Modify: `pos-frontend/src/lib/api.js:883-884` (`BOOTSTRAP_DAY_END_COLS`)
- Modify: `pos-frontend/src/lib/api.js:3044-3052` (insert after `reopenDayEnd`)

**Interfaces:**
- Consumes: nothing new (uses `supabase`, `appError` already imported at the top of the
  file).
- Produces: `mapDayEndRow(row)` output gains `handoffConfirmedBy`, `handoffConfirmedByName`,
  `handoffConfirmedAt` fields (all present on every existing caller's output — additive,
  no existing consumer breaks). New export `confirmDayEndHandoff(dayEndId): Promise<DayEnd>`
  (return shape = `mapDayEndRow`'s output). Task 5 (`BranchHandoffs.jsx`) consumes both.

- [ ] **Step 1: Extend `mapDayEndRow`**

Current (`src/lib/api.js:21-52`):

```js
export function mapDayEndRow(row) {
  if (!row) return null
  const fmtTime = (value) =>
    value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  return {
    id: row.id,
    date: row.business_date,
    recordedCash: Number(row.recorded_cash),
    cashOnHand: Number(row.cash_on_hand),
    variance: Number(row.variance),
    expectedCash: Number(row.expected_cash ?? 0),
    note: row.note || '',
    status: row.status || 'closed',
    cashier: row.staff?.full_name || '',
    closedAt: fmtTime(row.closed_at),
    submittedAt: fmtTime(row.submitted_at),
    approvedAt: fmtTime(row.approved_at),
    reopenedAt: row.reopened_at ? fmtTime(row.reopened_at) : null,
    reopenReason: row.reopen_reason || '',
    dayReport: mapDayReport(row.day_report),
    branchId: row.branch_id || null,
    requestedAt: row.requested_at || null,
    requestedBy: row.requested_by || null,
    requestManager: row.request_manager === true,
    rejectedAt: row.rejected_at || null,
    rejectedBy: row.rejected_by || null,
    rejectReason: row.reject_reason || '',
    reopenRequestedAt: row.reopen_requested_at || null,
    reopenRequestedBy: row.reopen_requested_by || null,
    reopenRequestReason: row.reopen_request_reason || '',
  }
}
```

Change to (adds the 3 new fields at the end, before the closing brace):

```js
export function mapDayEndRow(row) {
  if (!row) return null
  const fmtTime = (value) =>
    value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  return {
    id: row.id,
    date: row.business_date,
    recordedCash: Number(row.recorded_cash),
    cashOnHand: Number(row.cash_on_hand),
    variance: Number(row.variance),
    expectedCash: Number(row.expected_cash ?? 0),
    note: row.note || '',
    status: row.status || 'closed',
    cashier: row.staff?.full_name || '',
    closedAt: fmtTime(row.closed_at),
    submittedAt: fmtTime(row.submitted_at),
    approvedAt: fmtTime(row.approved_at),
    reopenedAt: row.reopened_at ? fmtTime(row.reopened_at) : null,
    reopenReason: row.reopen_reason || '',
    dayReport: mapDayReport(row.day_report),
    branchId: row.branch_id || null,
    requestedAt: row.requested_at || null,
    requestedBy: row.requested_by || null,
    requestManager: row.request_manager === true,
    rejectedAt: row.rejected_at || null,
    rejectedBy: row.rejected_by || null,
    rejectReason: row.reject_reason || '',
    reopenRequestedAt: row.reopen_requested_at || null,
    reopenRequestedBy: row.reopen_requested_by || null,
    reopenRequestReason: row.reopen_request_reason || '',
    // Supervisor→manager cash handoff (migrate_day_end_cash_handoff.sql) — non-blocking,
    // no deadline, so these stay null on plenty of legitimately-closed days.
    handoffConfirmedBy: row.handoff_confirmed_by || null,
    handoffConfirmedByName: row.confirmer?.full_name || '',
    handoffConfirmedAt: row.handoff_confirmed_at || null,
  }
}
```

- [ ] **Step 2: Extend `BOOTSTRAP_DAY_END_COLS`**

Current (`src/lib/api.js:883-884`):

```js
const BOOTSTRAP_DAY_END_COLS =
  'id, business_date, recorded_cash, cash_on_hand, variance, expected_cash, note, status, closed_at, submitted_at, approved_at, reopened_at, reopen_reason, day_report, staff_id, branch_id, staff!staff_id(full_name), requested_at, requested_by, request_manager, reopen_requested_at, reopen_requested_by, reopen_request_reason'
```

Change to:

```js
const BOOTSTRAP_DAY_END_COLS =
  'id, business_date, recorded_cash, cash_on_hand, variance, expected_cash, note, status, closed_at, submitted_at, approved_at, reopened_at, reopen_reason, day_report, staff_id, branch_id, staff!staff_id(full_name), requested_at, requested_by, request_manager, reopen_requested_at, reopen_requested_by, reopen_request_reason, handoff_confirmed_by, handoff_confirmed_at, confirmer:staff!handoff_confirmed_by(full_name)'
```

This is the one column list every `day_ends` bootstrap query in the file already shares
(`bootstrapBranchActivity`, the single-day fetch, and the ranged fetch all use the same
constant) — extending it once covers `data.dayEnds` in `BranchDashboard.jsx` for free, no
new query.

- [ ] **Step 3: Add `confirmDayEndHandoff`**

Current (`src/lib/api.js:3044-3052`):

```js
export async function reopenDayEnd({ id, staffId, reason }) {
  const { data, error } = await supabase.rpc('reopen_day_end', {
    p_day_end_id: id,
    p_staff_id: staffId,
    p_reason: reason,
  })
  if (error) throw error
  return data
}
```

Change to (adds a new function right after, nothing removed):

```js
export async function reopenDayEnd({ id, staffId, reason }) {
  const { data, error } = await supabase.rpc('reopen_day_end', {
    p_day_end_id: id,
    p_staff_id: staffId,
    p_reason: reason,
  })
  if (error) throw error
  return data
}

/**
 * Manager confirms physically receiving a closed day's cash. Non-blocking, no deadline —
 * Close day never waits on this; a manager runs it whenever the cash actually arrives,
 * even days later for a branch that isn't close by. Idempotent on the server.
 * Needs migrate_day_end_cash_handoff.sql.
 */
export async function confirmDayEndHandoff(dayEndId) {
  const { data, error } = await supabase.rpc('confirm_day_end_handoff', {
    p_day_end_id: dayEndId,
  })
  if (error) {
    const raw = String(error?.message || error || '')
    if (/Could not find the function.*confirm_day_end_handoff|function public\.confirm_day_end_handoff.*does not exist/i.test(raw)) {
      throw appError('TILL05', 'confirm_day_end_handoff is missing — apply migrate_day_end_cash_handoff.sql')
    }
    if (/DAYEND_NOT_CLOSED|DAYEND_NOT_ALLOWED|DAYEND_NOT_FOUND/.test(raw)) {
      throw appError('TILL05', raw)
    }
    throw error
  }
  return mapDayEndRow(Array.isArray(data) ? data[0] : data)
}
```

- [ ] **Step 4: Lint and build**

Run: `cd pos-frontend && npm run lint && npm run build`
Expected: both pass with no new errors.

- [ ] **Step 5: Commit**

```bash
git add pos-frontend/src/lib/api.js
git commit -m "feat: expose day-end cash handoff columns and confirm RPC wrapper"
```

---

### Task 4: `ShiftGate.jsx` — fix the Handover notice condition

**Files:**
- Modify: `pos-frontend/src/components/shared/ShiftGate.jsx:191-198` (`autoStarting`)
- Modify: `pos-frontend/src/components/shared/ShiftGate.jsx:379-540` (render branches)

**Interfaces:**
- Consumes: existing `carried` (`handoff?.endingCash`, line 109), existing
  `needsFreshCount` (line 91) — both unchanged.
- Produces: nothing new consumed elsewhere — this is a leaf UI fix.

- [ ] **Step 1: Add `showHandoverNotice` and gate `autoStarting` on it**

Current (`ShiftGate.jsx:192-198`):

```js
  const autoStartedRef = useRef(false)
  const autoStarting =
    !canChooseDrawer &&
    gate === 'start' &&
    !dayClosed &&
    holdsDrawer &&
    !needsFreshCount &&
    !restartPrompt
```

Change to:

```js
  // Ordinary cashier-to-cashier turnover on the SAME drawer, with a counted figure already
  // on record (a supervisor ran Confirm received handoff for the previous shift at some
  // earlier Day End) — informational only, no forced recount. Explicitly excludes
  // needsFreshCount: right after a manager reopens a closed day the cashier holding the
  // drawer never actually held that prior cash themselves (it was already handed to the
  // supervisor at the close before reopening), so no previous figure is shown there at all.
  const showHandoverNotice = holdsDrawer && carried != null && !needsFreshCount

  const autoStartedRef = useRef(false)
  const autoStarting =
    !canChooseDrawer &&
    gate === 'start' &&
    !dayClosed &&
    holdsDrawer &&
    !needsFreshCount &&
    !showHandoverNotice &&
    !restartPrompt
```

- [ ] **Step 2: Remove the Handover box from the `needsFreshCount` render branch**

Current (`ShiftGate.jsx:494-505`):

```jsx
      {needsFreshCount && (
        <>
          {carried != null && (
            <div className="mt-3 rounded-md border border-brand-warn-line bg-brand-warn-surface px-3 py-2.5">
              <strong className="block text-[11px] text-brand-warn">Handover</strong>
              <p className="m-0 mt-1 text-[11px] leading-snug text-brand-warn">
                {handoff?.staffName ? `${handoff.staffName} ` : 'The previous shift '}
                cashed out with <strong>{money(carried)}</strong> in this drawer. Count it yourself,
                from here it is your figure.
              </p>
            </div>
          )}
          <Field
```

Change to (drops the whole `carried != null` block — a reopened day starts clean, no
reference to a prior figure):

```jsx
      {needsFreshCount && (
        <>
          <Field
```

- [ ] **Step 3: Render the new Handover acknowledgment modal**

Current (`ShiftGate.jsx:376-379`, right before the routine-auto-start overlay):

```jsx
  // Routine case — see needsFreshCount above. No count needed; startShift already fired
  // from the effect. This only renders long enough to cover that local-first write (usually
  // imperceptible) or to offer a retry if it genuinely failed (offline mid-write, etc.).
  if (autoStarting) {
```

Change to (inserts a new branch immediately before the existing `if (autoStarting)`, does
not touch that block itself):

```jsx
  // Ordinary turnover with a counted figure on record — see showHandoverNotice above. Pure
  // acknowledgment: no amount field, no checkbox, no forced recount. Day-end remains the
  // only mandatory cash count; this is purely "here's what you're taking over".
  if (showHandoverNotice) {
    return (
      <Modal>
        <Eyebrow>START SHIFT</Eyebrow>
        <h2 className="mb-1 text-lg">Start your shift</h2>
        <div className="mt-1 rounded-md border border-brand-warn-line bg-brand-warn-surface px-3 py-2.5">
          <strong className="block text-[11px] text-brand-warn">Handover</strong>
          <p className="m-0 mt-1 text-[11px] leading-snug text-brand-warn">
            {handoff?.staffName ? `${handoff.staffName} ` : 'The previous shift '}
            cashed out with <strong>{money(carried)}</strong> in {drawerLabel || 'this drawer'}.
          </p>
        </div>
        {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
        <ModalActions>
          <SecondaryButton compact type="button" disabled={busy} onClick={onSignOut}>
            Sign out
          </SecondaryButton>
          <PrimaryButton
            compact
            type="button"
            disabled={busy}
            onClick={() => void doStart({ startingCash: 0 })}
          >
            {busy ? 'Starting…' : 'Start shift'}
          </PrimaryButton>
        </ModalActions>
      </Modal>
    )
  }

  // Routine case — see needsFreshCount above. No count needed; startShift already fired
  // from the effect. This only renders long enough to cover that local-first write (usually
  // imperceptible) or to offer a retry if it genuinely failed (offline mid-write, etc.).
  if (autoStarting) {
```

- [ ] **Step 4: Lint and build**

Run: `cd pos-frontend && npm run lint && npm run build`
Expected: both pass, no new errors.

- [ ] **Step 5: Manual verification**

Run: `cd pos-frontend && npm run dev`
- Reopen a closed day as manager, start a new shift on that drawer → blank fresh-count
  form appears, **no** Handover box anywhere on it.
- With a drawer shift whose `ending_cash` is already set from a prior `receive_shift_handoff`
  (or seed one via the Supabase SQL editor for a quick manual check), sign in as a
  different cashier on the same drawer → the new "Start your shift" Handover
  acknowledgment modal appears with the previous cashier's name and amount; tapping
  "Start shift" opens the new shift at ₱0 change fund.

- [ ] **Step 6: Commit**

```bash
git add pos-frontend/src/components/shared/ShiftGate.jsx
git commit -m "fix: show Handover notice on cashier turnover, not on day reopen"
```

---

### Task 5: `BranchHandoffs.jsx` — new panel component

**Files:**
- Create: `pos-frontend/src/components/dayend/BranchHandoffs.jsx`

**Interfaces:**
- Consumes: `confirmDayEndHandoff(dayEndId)` and `fetchShiftAdjustments(shiftIds)` from
  `../../lib/api` (both already exist after Task 3 / already exported today); `money`
  from `../../utils/format`; `formatSupportError` from `../../utils/errors`; `TableCard`,
  `PrimaryButton` from `../ui`.
- Props: `dayEnds` (array of `mapDayEndRow` output, from `data.dayEnds`), `staffShifts`
  (array of `mapShiftRow`-shaped rows via `fetchStaffShifts`, from `BranchDashboard`'s
  `staffShifts` state), `onReload` (async function, re-fetches branch data).
- Produces: default export `BranchHandoffs`, consumed by Task 6.

- [ ] **Step 1: Write the component**

```jsx
import { useEffect, useMemo, useState } from 'react'
import { TableCard, PrimaryButton } from '../ui'
import { confirmDayEndHandoff, fetchShiftAdjustments } from '../../lib/api'
import { formatSupportError } from '../../utils/errors'
import { money } from '../../utils/format'

/**
 * Two read/act sections for a branch's cash custody trail:
 *   - Cashier → supervisor: read-only. A drawer shift only carries `endingCash` once a
 *     supervisor has already run Confirm received handoff at Day End — so every row here
 *     is already confirmed by construction, nothing left to act on.
 *   - Supervisor → manager: each closed day_end's cash total, individually checkable,
 *     confirmed via confirmDayEndHandoff — no deadline, no blocking, pure record-keeping.
 */
function BranchHandoffs({ dayEnds = [], staffShifts = [], onReload }) {
  const shiftHandoffs = useMemo(
    () =>
      (staffShifts || [])
        .filter((row) => row.holdsDrawer && !row.open && row.endingCash != null)
        .sort((a, b) => new Date(b.clockOut || 0) - new Date(a.clockOut || 0)),
    [staffShifts],
  )
  const shiftIds = useMemo(
    () => shiftHandoffs.map((row) => row.serverId || row.id).filter(Boolean),
    [shiftHandoffs],
  )
  const shiftIdsKey = shiftIds.join(',')

  const [adjustments, setAdjustments] = useState([])
  useEffect(() => {
    let cancelled = false
    if (!shiftIds.length) {
      setAdjustments([])
      return undefined
    }
    fetchShiftAdjustments(shiftIds).then((rows) => {
      if (!cancelled) setAdjustments(rows)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftIdsKey])

  const receivedByShiftId = useMemo(() => {
    const map = new Map()
    for (const row of adjustments) {
      if (row.field !== 'ending_cash') continue
      if (!map.has(row.shiftId)) map.set(row.shiftId, row)
    }
    return map
  }, [adjustments])

  const dayEndHandoffs = useMemo(() => (dayEnds || []).filter((row) => row.status === 'closed'), [dayEnds])

  const [selected, setSelected] = useState(() => new Set())
  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const confirmSelected = async () => {
    if (!selected.size) return
    setBusy(true)
    setError('')
    try {
      for (const id of selected) {
        await confirmDayEndHandoff(id)
      }
      setSelected(new Set())
      await onReload?.()
    } catch (err) {
      setError(formatSupportError(err, 'TILL05'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <TableCard className="mb-3.5 max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Cashier → supervisor</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          Drawer shifts a supervisor already confirmed received at Day End. Read-only —
          confirm this from Day end, not here.
        </p>
        {shiftHandoffs.length === 0 ? (
          <p className="m-0 text-xs text-brand-subtle">No received handoffs yet.</p>
        ) : (
          <ul className="m-0 list-disc space-y-1 pl-5 text-xs text-brand-muted">
            {shiftHandoffs.map((row) => {
              const received = receivedByShiftId.get(row.serverId || row.id)
              return (
                <li key={row.id}>
                  {row.staffName} · {row.businessDate} · {money(row.endingCash)}
                  {received ? ` · received by ${received.adjustedByName || 'supervisor'}` : ''}
                </li>
              )
            })}
          </ul>
        )}
      </TableCard>

      <TableCard className="max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Supervisor → manager</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          Closed business days for this branch. Select the ones you have physically
          received cash for — no deadline, confirm whenever the cash actually arrives.
        </p>
        {dayEndHandoffs.length === 0 ? (
          <p className="m-0 text-xs text-brand-subtle">No closed days yet.</p>
        ) : (
          <ul className="m-0 mb-3 space-y-1.5 text-xs">
            {dayEndHandoffs.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-2 border-b border-brand-softline pb-1.5"
              >
                <label className="flex min-w-0 items-center gap-2">
                  {!row.handoffConfirmedAt && (
                    <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
                  )}
                  <span className="truncate text-brand-ink">{row.date}</span>
                </label>
                <span className="shrink-0 text-brand-muted">
                  {money(row.cashOnHand)}
                  {row.handoffConfirmedAt
                    ? ` · received by ${row.handoffConfirmedByName || 'manager'}`
                    : ' · pending'}
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="mb-2 text-xs text-brand-danger">{error}</p>}
        <PrimaryButton compact type="button" disabled={busy || !selected.size} onClick={() => void confirmSelected()}>
          {busy ? 'Confirming…' : `Confirm received (${selected.size})`}
        </PrimaryButton>
      </TableCard>
    </div>
  )
}

export default BranchHandoffs
```

- [ ] **Step 2: Lint**

Run: `cd pos-frontend && npm run lint`
Expected: no new errors. (Build is verified together with Task 6, once this component is
actually imported/used — an unused new file would otherwise fail the build's dead-export
checks in some setups; wiring it in immediately in Task 6 avoids that entirely.)

- [ ] **Step 3: Commit**

```bash
git add pos-frontend/src/components/dayend/BranchHandoffs.jsx
git commit -m "feat: add BranchHandoffs cash-handoff report/confirm panel"
```

---

### Task 6: Wire `BranchHandoffs` into `BranchDashboard.jsx` behind a new tab

**Files:**
- Modify: `pos-frontend/src/pages/manager/BranchDashboard.jsx:1-9` (imports)
- Modify: `pos-frontend/src/pages/manager/BranchDashboard.jsx:156-169` (component state)
- Modify: `pos-frontend/src/pages/manager/BranchDashboard.jsx:944-949` (insert Tabs, open
  the `overview` wrapper)
- Modify: `pos-frontend/src/pages/manager/BranchDashboard.jsx:2472-2474` (close the
  `overview` wrapper, add the `handoffs` branch)

**Interfaces:**
- Consumes: `BranchHandoffs` (default export, Task 5), existing `data.dayEnds`,
  `staffShifts` state, `reload` function — all already defined earlier in this component.
- Produces: nothing new consumed elsewhere — this is the final integration point.

- [ ] **Step 1: Import the new component**

Current (`BranchDashboard.jsx:4-6`):

```js
import TransactionDetailModal from '../../components/transactions/TransactionDetailModal'
import DayEndClosingDetail from '../../components/dayend/DayEndClosingDetail'
import { DayEndReportPanels } from '../../components/dayend/DayEndReportPanels'
```

Change to:

```js
import TransactionDetailModal from '../../components/transactions/TransactionDetailModal'
import DayEndClosingDetail from '../../components/dayend/DayEndClosingDetail'
import { DayEndReportPanels } from '../../components/dayend/DayEndReportPanels'
import BranchHandoffs from '../../components/dayend/BranchHandoffs'
```

- [ ] **Step 2: Add `mainTab` state**

Current (`BranchDashboard.jsx:156-159`):

```js
function ManagerBranchDashboard() {
  const { branchId } = useParams()
  const user = useAuthStore((state) => state.user)
  const [branch, setBranch] = useState(null)
```

Change to:

```js
function ManagerBranchDashboard() {
  const { branchId } = useParams()
  const user = useAuthStore((state) => state.user)
  const [branch, setBranch] = useState(null)
  // Overview = everything this page already rendered; Handoffs = the new cash-custody
  // report/confirm panel. A plain top-level switch, same Tabs component already used for
  // invTab below — nothing under either branch depends on which one is active.
  const [mainTab, setMainTab] = useState('overview')
```

- [ ] **Step 3: Insert the Tabs control and open the `overview` wrapper**

Current (`BranchDashboard.jsx:944-949`):

```jsx
      </PageHeader>
      {error && (
        <ErrorBanner error={error} onDismiss={() => setError('')} />
      )}

      <div className="mb-3.5 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] items-stretch gap-3.5 max-[700px]:grid-cols-1">
```

Change to:

```jsx
      </PageHeader>
      {error && (
        <ErrorBanner error={error} onDismiss={() => setError('')} />
      )}

      <Tabs
        className="mb-3.5"
        value={mainTab}
        onChange={setMainTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'handoffs', label: 'Handoffs' },
        ]}
      />

      {mainTab === 'overview' && (
      <div className="mb-3.5 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] items-stretch gap-3.5 max-[700px]:grid-cols-1">
```

- [ ] **Step 4: Close the `overview` wrapper and add the `handoffs` branch**

Current (`BranchDashboard.jsx:2470-2474`, the end of the component's return — the last
modal followed by the outer `</div>`):

```jsx
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}
```

Change to:

```jsx
          </ModalActions>
        </Modal>
      )}
      </div>
      )}

      {mainTab === 'handoffs' && (
        <BranchHandoffs dayEnds={data.dayEnds} staffShifts={staffShifts} onReload={reload} />
      )}
    </div>
  )
}
```

Note the extra `</div>` and `)}` right after the `reopenTarget` modal's closing `)}` — that
closes, in order, the `overview`-branch `<div>` opened in Step 3 and the
`{mainTab === 'overview' && (` conditional itself. The final `</div>` / `)` / `}` (the
component's own outer container and function close) are unchanged from before.

- [ ] **Step 5: Lint and build**

Run: `cd pos-frontend && npm run lint && npm run build`
Expected: both pass — this is the step that would surface a mismatched brace/paren from
Steps 3-4 (build fails fast on invalid JSX nesting).

- [ ] **Step 6: Manual verification**

Run: `cd pos-frontend && npm run dev`
- Sign in as manager, open a branch → "Overview" tab shows exactly what it did before
  this change (nothing visually different).
- Switch to "Handoffs" tab → both sections render; cashier→supervisor list matches known
  received shifts; supervisor→manager list shows closed days with checkboxes.
- Select 2+ closed days, tap "Confirm received (N)" → rows flip to "received by
  <manager name>", checkboxes disappear from those rows, count resets to 0.
- Reload the page → confirmed state persists (proves it round-tripped through
  `data.dayEnds`, not just local state).

- [ ] **Step 7: Commit**

```bash
git add pos-frontend/src/pages/manager/BranchDashboard.jsx
git commit -m "feat: add Handoffs tab to branch dashboard"
```

---

### Task 7: Update `CODEMAP.md`

**Files:**
- Modify: `pos-frontend/docs/CODEMAP.md` (Day End / shift-handoff section, the area
  documenting `ShiftGate.jsx`'s handoff/reopen behavior and the existing "Received
  handoff" flow — same section referenced in this plan's spec)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Locate the section**

Run: `grep -n "needsFreshCount\|Received handoff\|receive_shift_handoff" pos-frontend/docs/CODEMAP.md`

Find the paragraph(s) describing `ShiftGate.jsx`'s reopen/handoff condition and the
supervisor's "Confirm received handoff" flow.

- [ ] **Step 2: Add a short correction + new-feature note**

Immediately after the existing paragraph that describes `needsFreshCount` /
`receive_shift_handoff`, add:

```markdown
**`ShiftGate.jsx`'s Handover notice** shows only on ordinary same-drawer cashier turnover
(`showHandoverNotice`), never during a manager-reopened day's fresh count
(`needsFreshCount`) — a cashier picking up after a reopen never actually held the prior
drawer's cash themselves, so no previous figure is referenced there. It is informational
only: no amount field, no forced recount — day-end remains the single mandatory cash
count per business day.

**Supervisor→manager cash handoff** (`migrate_day_end_cash_handoff.sql`): a manager
confirms physically receiving a closed day's cash via `confirm_day_end_handoff(day_end_id)`
(`day_ends.handoff_confirmed_by`/`handoff_confirmed_at`), from the branch dashboard's
**Handoffs** tab (`src/pages/manager/BranchDashboard.jsx` → `src/components/dayend/BranchHandoffs.jsx`).
Deliberately non-blocking and deadline-free — Close day/Submit day/Approve day never wait
on it; a manager can confirm several closed days (a week's worth) in one action. The same
tab also lists cashier→supervisor handoffs read-only (sourced from `staff_shifts` +
`shift_adjustments`) — that half of the flow is unchanged, still confirmed once per
business day from Day End's existing "Confirm received handoff".
```

- [ ] **Step 3: Commit**

```bash
git add pos-frontend/docs/CODEMAP.md
git commit -m "docs: document cash handoff tracking in CODEMAP"
```

---

### Task 8: Version bump + CHANGELOG (final task — requires user confirmation first)

**Files:**
- Modify: `pos-frontend/package.json` (`version`)
- Modify: `pos-frontend/CHANGELOG.md` (new entry at the top of the version list)

**Interfaces:** none.

- [ ] **Step 1: Confirm with the user before touching version**

Per this project's rule (`CLAUDE.md`): version is bumped only when the user accepts it,
prompted at the time. Before editing `package.json`, ask the user to confirm the MINOR
bump `0.24.1` → `0.25.0` for this feature (new capability + a behavior fix, no fiscal/
retraining impact) — do not bump silently even though earlier turns in this conversation
approved the feature itself.

- [ ] **Step 2: Bump `package.json`**

Current (`pos-frontend/package.json:1-4`):

```json
{
  "name": "calepos",
  "private": true,
  "version": "0.24.1",
```

Change to:

```json
{
  "name": "calepos",
  "private": true,
  "version": "0.25.0",
```

- [ ] **Step 3: Add the CHANGELOG entry**

Current (`pos-frontend/CHANGELOG.md`, right after the `---` divider, before the existing
`## 0.24.1` entry):

```markdown
---

## 0.24.1 — 2026-08-20
```

Change to:

```markdown
---

## 0.25.0 — 2026-08-20

### Added: supervisor→manager cash handoff tracking + fixed Handover notice

New branch-dashboard "Handoffs" tab lets a manager confirm receiving a closed day's
cash whenever it physically arrives — no deadline, doesn't block Close day/Submit
day/Approve day. Selecting several closed days confirms a week's worth in one action.
The same tab also lists cashier→supervisor handoffs read-only (unchanged mechanics,
still confirmed once per day from Day End). Also fixed `ShiftGate.jsx`'s "Handover"
notice, which previously only appeared on a manager-reopened day (where it shouldn't
— that cash was already handed to the supervisor before the reopen) and never on an
ordinary cashier-to-cashier drawer turnover (where it should). It now shows correctly
on ordinary turnover only, informational, with no forced recount.

## 0.24.1 — 2026-08-20
```

- [ ] **Step 4: Build**

Run: `cd pos-frontend && npm run build`
Expected: passes — confirms `__APP_VERSION__` picks up the bump cleanly.

- [ ] **Step 5: Commit**

```bash
git add pos-frontend/package.json pos-frontend/CHANGELOG.md
git commit -m "chore: bump version to 0.25.0 for cash handoff tracking"
```
