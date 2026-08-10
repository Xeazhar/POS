import { useEffect, useMemo, useState } from 'react'
import { DayEndReportPanels } from '../components/dayend/DayEndReportPanels'
import PettyCashPanel from '../components/dayend/PettyCashPanel'
import ShiftCashOut from '../components/shared/ShiftCashOut'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PageSkeleton,
  PrimaryButton,
  SecondaryButton,
  StatusBadge,
  TableCard,
  moneyClass,
  varianceToneClass,
} from '../components/ui'
import {
  addPettyCash,
  closeShift,
  fetchPettyCash,
  fetchSoldLineItems,
  fetchStaffShifts,
  hasSupabase,
} from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { cashPositionNotice, useShiftStore } from '../stores/shiftStore'
import { buildDayEndReport } from '../utils/dayEndReport'
import { formatSupportError } from '../utils/errors'
import {
  businessDate,
  dayEndForBusinessDate,
  formatOpenHourLabel,
  money,
  rowBusinessDate,
} from '../utils/format'
import { isManagerRole, isSupervisorOrAbove } from '../utils/roles'
import { decimalOnly } from '../utils/validate'

const rowKind = (row) =>
  row.kind ||
  (String(row.reason || '').startsWith('[CHANGE FUND]')
    ? 'change_fund'
    : String(row.reason || '').startsWith('[PICKUP]')
      ? 'pickup'
      : 'paid_out')

const rowStatus = (row) => row.status || (rowKind(row) === 'paid_out' ? 'fulfilled' : 'recorded')

const FUND_GRID =
  'grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_minmax(0,0.75fr)]'
const FUND_GRID_NARROW = 'max-[700px]:grid-cols-[minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]'

/**
 * Shift state as a badge, separate from the drawer name.
 *
 * "main · open now" forced a supervisor to read a drawer id and a lifecycle state out of
 * one string. A shift never carries an ending count anymore (the drawer is counted once at
 * Day End, not per shift) — so "no ending cash" is the normal closed state now, not a
 * warning to chase.
 */
function shiftStatusBadge(row) {
  if (row.open) return { label: 'Open', tone: 'success', hint: 'Cashier is on this drawer now' }
  return { label: 'Closed', tone: 'neutral', hint: 'Shift ended' }
}

/**
 * Day end / End shift.
 *
 * One route, two screens, because these are two different jobs done by two different
 * people. A cashier closing their own till has no business seeing another cashier's
 * drawer figures — the old shared screen listed every shift's change fund to everyone
 * standing at the counter, which is both a privacy leak and a way to learn what a
 * supervisor's float looks like. Supervisor+ keeps the branch-wide view.
 */
function DayEnd() {
  const user = useAuthStore((state) => state.user)
  return isSupervisorOrAbove(user?.role) ? <SupervisorDayEnd /> : <CashierEndShift />
}

/* ────────────────────────────────────────────────────────────────────────────
   Shared data hook — both views read the same two sources.
   ──────────────────────────────────────────────────────────────────────────── */
function useDayEndData(user, date) {
  const [petty, setPetty] = useState([])
  const [shifts, setShifts] = useState([])
  const [loading, setLoading] = useState(Boolean(hasSupabase && user?.branchId))

  const reload = async () => {
    if (!hasSupabase || !user?.branchId) {
      setPetty([])
      setShifts([])
      return
    }
    const [pettyRows, shiftRows] = await Promise.all([
      fetchPettyCash(user.branchId, date).catch(() => []),
      fetchStaffShifts({ branchId: user.branchId, start: date, end: date }).catch(() => []),
    ])
    setPetty(pettyRows || [])
    setShifts(shiftRows || [])
  }

  useEffect(() => {
    let active = true
    if (!hasSupabase || !user?.branchId) {
      setPetty([])
      setShifts([])
      setLoading(false)
      return undefined
    }
    setLoading(true)
    reload()
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.branchId, date])

  return { petty, shifts, loading, reload }
}

/* ────────────────────────────────────────────────────────────────────────────
   CASHIER — "End shift"
   Own drawer only. No aggregate sales, no other cashiers, no restock list, and
   no Submit for closing — that action belongs to a supervisor.
   ──────────────────────────────────────────────────────────────────────────── */
function CashierEndShift() {
  const user = useAuthStore((state) => state.user)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const date = businessDate(new Date(), dayOpenHour)
  const shift = useShiftStore((state) => state.shift)
  const cashPosition = useShiftStore((state) => state.cashPosition)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const requestDay = useInventoryStore((state) => state.requestDay)
  // Live sale activity on this device — a dependency here (not just shift/petty) is what
  // makes a just-rung sale show up without navigating away and back.
  const transactions = useInventoryStore((state) => state.transactions)

  const { petty, loading, reload } = useDayEndData(user, date)
  const [position, setPosition] = useState(null)
  const [cashOutOpen, setCashOutOpen] = useState(false)
  const [requestManagerToggle, setRequestManagerToggle] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [requestError, setRequestError] = useState('')

  useEffect(() => {
    let active = true
    if (!shift) {
      setPosition(null)
      return undefined
    }
    cashPosition()
      .then((result) => {
        if (active) setPosition(result)
      })
      .catch(() => {
        if (active) setPosition(null)
      })
    return () => {
      active = false
    }
  }, [shift, cashPosition, petty, transactions])

  // Only this cashier's own requests. Scoped in the UI as well as by intent: the branch
  // read returns every row, and a cashier must not see what other staff asked for.
  const myPetty = useMemo(
    () =>
      petty.filter(
        (row) =>
          rowKind(row) === 'paid_out' &&
          (row.requestedBy === user?.id || row.staffId === user?.id),
      ),
    [petty, user?.id],
  )

  // Informational only, same as SupervisorDayEnd's version — `cashSales` above is already
  // net of discount (the customer only ever hands over the discounted amount), so this does
  // not change the "Drawer should hold" total. Scoped to this shift the same way
  // shiftStore's shiftCashRows() is, so it lines up with `position.cashSales`.
  const cashDiscounts = useMemo(() => {
    if (!shift) return 0
    return transactions
      .filter(
        (row) =>
          (row.shiftClientId && row.shiftClientId === shift.clientId) ||
          (shift.serverId && row.shiftId === shift.serverId),
      )
      .filter((row) => row.status === 'Paid' && (row.paymentMethod || 'cash') === 'cash')
      .reduce((sum, row) => sum + Number(row.discountAmount || 0), 0)
  }, [transactions, shift])

  if (loading) return <PageSkeleton variant="dashboard" />

  const expected = position ? Number(position.expectedCash || 0) : null
  const cashSalesGross = position ? Number((Number(position.cashSales || 0) + cashDiscounts).toFixed(2)) : null
  const shiftNotice = cashPositionNotice(position)
  const todayEntry = dayEnds.find((item) => item.date === date)
  const dayRequested = todayEntry?.status === 'requested'
  const dayInProgress = todayEntry?.status === 'submitted' || todayEntry?.status === 'closed'

  const handleRequestDayEnd = async () => {
    setRequesting(true)
    setRequestError('')
    try {
      await requestDay(requestManagerToggle)
    } catch (err) {
      setRequestError(formatSupportError(err, 'TILL02'))
    } finally {
      setRequesting(false)
    }
  }

  return (
    <div>
      <PageHeader eyebrow="MY DRAWER" title="End shift">
        <span className="text-xs text-brand-n600">
          Business day {date} · opens {formatOpenHourLabel(dayOpenHour)}
        </span>
      </PageHeader>

      <TableCard className="mb-3.5 max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Your shift so far</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          These figures cover YOUR shift only — the drawer itself is counted once for the
          whole business day, at Day End, not per shift. If another shift used this drawer
          today too, Day End's "Expected in drawer" covers the whole day and will not match
          this total; that is expected, not an error.
        </p>
        {!shift ? (
          <p className="m-0 text-xs text-brand-subtle">No open shift on this drawer.</p>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-1.5 rounded-md border border-brand-softline px-3.5 py-3 text-[13px]">
              <span className="text-brand-subtle">Change fund in</span>
              <strong className={`text-right ${moneyClass}`}>
                {money(position?.startingCash ?? shift.startingCash)}
              </strong>
              <span className="text-brand-subtle">+ Cash sales</span>
              <strong className={`text-right ${moneyClass}`}>{money(position?.cashSales)}</strong>
              {cashDiscounts > 0 && (
                <span className="col-span-2 -mt-1 text-[11px] text-brand-subtle">
                  ({money(cashSalesGross)} before discounts − {money(cashDiscounts)} in
                  discounts — already reflected in Cash sales above, not deducted again)
                </span>
              )}
              {Number(position?.cashRefunds || 0) > 0 && (
                <>
                  <span className="text-brand-subtle">− Refunds / voids</span>
                  <strong className={`text-right ${moneyClass}`}>
                    −{money(position?.cashRefunds)}
                  </strong>
                </>
              )}
              <span className="text-brand-subtle">− Paid out (handed over)</span>
              <strong className={`text-right ${moneyClass}`}>
                −{money(position?.cashPaidOut)}
              </strong>
              <span className="text-brand-subtle">− Pickups to safe</span>
              <strong className={`text-right ${moneyClass}`}>
                −{money(position?.cashPickups)}
              </strong>
              <span className="border-t border-brand-softline pt-1.5 font-bold">
                = Drawer should hold
              </span>
              <strong className={`border-t border-brand-softline pt-1.5 text-right font-bold ${moneyClass}`}>
                {expected == null ? '—' : money(expected)}
              </strong>
            </div>
            {shiftNotice && (
              <p
                className={`mt-3 rounded-md px-2.5 py-2 text-[11px] ${
                  shiftNotice.tone === 'warn'
                    ? 'bg-brand-warn-bg text-brand-warn'
                    : 'bg-brand-n50 text-brand-muted'
                }`}
              >
                {shiftNotice.text}
              </p>
            )}
            <PrimaryButton compact type="button" className="mt-3" onClick={() => setCashOutOpen(true)}>
              End shift
            </PrimaryButton>
          </>
        )}
      </TableCard>

      <TableCard className="mb-3.5 max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Day end</h2>
        {dayInProgress ? (
          <p className="m-0 text-xs text-brand-muted">
            {todayEntry.status === 'closed'
              ? 'Day is closed.'
              : 'Day end is submitted — waiting on approval.'}
          </p>
        ) : dayRequested ? (
          <p className="m-0 text-xs text-brand-muted">
            Requested — waiting for {todayEntry.requestManager ? 'a manager' : 'a supervisor'}{' '}
            to count the drawer and close the day.
          </p>
        ) : shift ? (
          // Requesting day end while still clocked in reads as "close the whole business
          // day" while this cashier's own drawer isn't even counted yet — End shift first
          // (above), then this card unlocks. Keeps the two actions in the order they
          // actually have to happen in.
          <p className="m-0 text-xs text-brand-subtle">
            End your shift first (above) — Request day end unlocks once your drawer is closed.
          </p>
        ) : (
          <>
            {todayEntry?.status === 'rejected' && (
              <p className="m-0 mb-3 rounded-md bg-brand-warn-bg px-2.5 py-2 text-[11px] text-brand-warn">
                Your last request was declined
                {todayEntry.rejectedAt ? ` at ${todayEntry.rejectedAt}` : ''}
                {todayEntry.rejectReason ? `: ${todayEntry.rejectReason}` : '.'} Request again
                once ready.
              </p>
            )}
            <p className="m-0 mb-3 text-xs text-brand-muted">
              Done selling for the day? Request day end — a supervisor counts the drawer and
              closes it, or a manager if none is available.
            </p>
            <label className="mb-3 flex items-start gap-2 text-[11px] leading-snug text-brand-muted">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={requestManagerToggle}
                onChange={(e) => setRequestManagerToggle(e.target.checked)}
              />
              <span>No supervisor available — request manager instead.</span>
            </label>
            {requestError && <p className="mb-2 text-xs text-brand-danger">{requestError}</p>}
            <SecondaryButton compact type="button" disabled={requesting} onClick={handleRequestDayEnd}>
              {requesting ? 'Requesting…' : 'Request day end'}
            </SecondaryButton>
          </>
        )}
      </TableCard>

      <PettyCashPanel
        rows={myPetty}
        user={user}
        branchId={user?.branchId}
        businessDate={date}
        shiftId={shift?.serverId || null}
        canApprove={false}
        canRequest
        scope="mine"
        onChanged={reload}
      />

      {cashOutOpen && shift && (
        <ShiftCashOut
          user={user}
          shift={shift}
          onCancel={() => setCashOutOpen(false)}
          onDone={() => {
            // No resolve() here: endShift already set gate 'ended'. This page stays open
            // past that (see Shell's shiftBlocking) so Request day end below is still
            // reachable, but re-resolving would ask the server "is a shift open?", get no,
            // and jump straight to "count a new change fund" — skipping the sign-out this
            // session is supposed to require before anyone starts the next shift here.
            setCashOutOpen(false)
          }}
        />
      )}
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────────
   SUPERVISOR+ — "Day end"
   Branch-wide: aggregate sales, every shift side by side, restock, the petty
   cash approval queue, and Submit for closing (the Z-reading gate).
   ──────────────────────────────────────────────────────────────────────────── */
function SupervisorDayEnd() {
  const user = useAuthStore((state) => state.user)
  const isRestaurant = user?.branchType === 'restaurant'
  const products = useProductStore((state) => state.products)
  const productsLoading = useProductStore((state) => state.loading)
  const transactions = useInventoryStore((state) => state.transactions)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const submitDay = useInventoryStore((state) => state.submitDay)
  const approveDay = useInventoryStore((state) => state.approveDay)
  const reopenDay = useInventoryStore((state) => state.reopenDay)
  const rejectDayRequest = useInventoryStore((state) => state.rejectDayRequest)
  const isManager = isManagerRole(user?.role)

  const date = businessDate(new Date(), dayOpenHour)
  const { petty, shifts, loading, reload } = useDayEndData(user, date)

  // rowBusinessDate, NOT item.date: `date` here is a business date, and item.date is the
  // plain calendar date. Comparing them drops every sale rung between midnight and the open
  // hour out of its own business day (and counts the previous day's early hours instead) —
  // which is exactly how this screen's total could disagree with the cashier's shift figure,
  // since shift_cash_summary() scopes by shift_id and applies no date filter at all.
  const inBusinessDay = (item) => rowBusinessDate(item, dayOpenHour) === date
  const recorded = transactions
    .filter((item) => item.status === 'Paid' && inBusinessDay(item))
    .reduce((sum, item) => sum + Number(item.netTotal ?? item.total), 0)
  const cashTransactions = transactions.filter(
    (item) =>
      item.status === 'Paid' && inBusinessDay(item) && (item.paymentMethod || 'cash') === 'cash',
  )
  const cashSales = cashTransactions.reduce((sum, item) => sum + Number(item.netTotal ?? item.total), 0)
  // Non-cash tenders — informational only, never part of the Expected-in-drawer math below.
  // Net of refunds, same as cashSales, so Cash + Card + E-wallet reconciles to `recorded`.
  const cardSales = transactions
    .filter((item) => item.status === 'Paid' && inBusinessDay(item) && item.paymentMethod === 'card')
    .reduce((sum, item) => sum + Number(item.netTotal ?? item.total), 0)
  const ewalletSales = transactions
    .filter((item) => item.status === 'Paid' && inBusinessDay(item) && item.paymentMethod === 'ewallet')
    .reduce((sum, item) => sum + Number(item.netTotal ?? item.total), 0)
  // Informational only — `total`/`netTotal` are already net of discount (the customer only
  // ever hands over the discounted amount), so this does not change any cash figure above.
  // It exists so "why is cash sales lower than the sticker prices would suggest" has an
  // answer on this screen instead of only in the separate Discount Report.
  const cashDiscounts = cashTransactions.reduce((sum, item) => sum + Number(item.discountAmount || 0), 0)
  const cashSalesGross = Number((cashSales + cashDiscounts).toFixed(2))

  const existing = dayEndForBusinessDate(dayEnds, date)
  const isSubmitted = existing?.status === 'submitted'
  const isClosed = existing?.status === 'closed'
  // A request has no real numbers yet (placeholder ₱0.00 figures) and does not lock the
  // till — it is a notification, not a submission. Only submitted/closed lock sales.
  const isRequested = existing?.status === 'requested'
  const isLocked = isSubmitted || isClosed
  const canApprove = isSubmitted
  // A cashier can flag "request manager" when no supervisor is available — that request is
  // not actionable from a supervisor's own screen, so they see a waiting message instead of
  // the Close Day form. Any manager can always act on it.
  const waitingForManager = isRequested && existing.requestManager && !isManager

  const [cashOnHand, setCashOnHand] = useState(
    existing && !isRequested ? String(existing.cashOnHand) : '',
  )
  const [note, setNote] = useState(existing?.note || '')
  const [confirmSubmit, setConfirmSubmit] = useState(false)
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [reopenOpen, setReopenOpen] = useState(false)
  const [reopenReason, setReopenReason] = useState('')
  const [declineOpen, setDeclineOpen] = useState(false)
  const [declineReason, setDeclineReason] = useState('')
  const [declineBusy, setDeclineBusy] = useState(false)
  const [declineError, setDeclineError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pickupAmount, setPickupAmount] = useState('')
  const [pickupNote, setPickupNote] = useState('')
  const [closingShift, setClosingShift] = useState(null)
  const [closingBusy, setClosingBusy] = useState(false)
  const [closingError, setClosingError] = useState('')

  const changeFundRows = petty.filter((row) => rowKind(row) === 'change_fund')
  const pickupRows = petty.filter((row) => rowKind(row) === 'pickup')
  const paidOutRows = petty.filter((row) => rowKind(row) === 'paid_out')

  // The change fund now lives on the shift that counted it (starting_cash), one per
  // cashier per drawer. The legacy cash_drawer_entries rows are still added in for days
  // recorded before migrate_shift_cash_accountability.sql — the two never overlap, because
  // the new flow writes no change_fund entry at all.
  const drawerShifts = shifts.filter((row) => row.holdsDrawer !== false)
  // Whoever is actually holding the drawer right now — NOT the viewing supervisor's own
  // shift (`activeShift`). A supervisor recording a pickup or requesting petty cash from
  // this screen is usually a different person than the cashier on the till, often with no
  // drawer shift of their own at all. Attributing to `activeShift` silently charged the
  // entry to the wrong shift (or none), so the cashier's shift-scoped RPC never saw it while
  // this page's own day-wide total did — a real source of "cashier and supervisor numbers
  // don't match" independent of shift count.
  const drawerHolderShift = drawerShifts.find((row) => row.open)
  const shiftFloatTotal = drawerShifts.reduce((sum, row) => sum + Number(row.startingCash || 0), 0)
  const legacyFloatTotal = changeFundRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const changeFundTotal = shiftFloatTotal + legacyFloatTotal
  const pickupTotal = pickupRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)

  // Only cash that has actually been handed over leaves the drawer. An approved request
  // still sitting in the till is a commitment, not a disbursement — deducting it here made
  // the drawer read short for as long as it went unfulfilled.
  const paidOutTotal = paidOutRows
    .filter((row) => rowStatus(row) === 'fulfilled')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const approvedUnfulfilled = paidOutRows
    .filter((row) => rowStatus(row) === 'approved')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const pendingCount = paidOutRows.filter((row) => rowStatus(row) === 'pending').length

  const expectedCash = Number((changeFundTotal + cashSales - paidOutTotal - pickupTotal).toFixed(2))
  // An untouched field is "not yet counted", not "counted as ₱0.00" — treating it as zero
  // showed a false "Short" the instant this screen loaded, before anyone had counted anything.
  const hasCashOnHand = cashOnHand !== ''
  const variance = Number(cashOnHand || 0) - expectedCash
  const noteRequired = hasCashOnHand && variance !== 0

  // Sold-item breakdown + restock suggestions read transaction_items (line_total — what was
  // actually charged) via a fresh fetch, not the local stock_movements log: that log survives
  // a debug transaction reset and would keep counting deleted test sales as if they sold
  // today, priced at today's live product price rather than what was charged. `null` means
  // "not loaded yet / unavailable offline" — distinct from `[]` ("loaded, nothing sold"), so
  // the panel below can tell a real zero-sales day apart from a fetch that never landed.
  const [soldItemRows, setSoldItemRows] = useState(null)
  useEffect(() => {
    if (!hasSupabase || !user?.branchId) {
      // No backend to reconnect to (offline demo mode) — treat as a real zero, not an error.
      setSoldItemRows([])
      return undefined
    }
    let active = true
    setSoldItemRows(null)
    // Same buffer-then-rowBusinessDate-narrow shape as fetchBranchCashImpact.
    const windowStart = new Date(`${date}T00:00:00`)
    windowStart.setDate(windowStart.getDate() - 1)
    const windowEnd = new Date(`${date}T00:00:00`)
    windowEnd.setDate(windowEnd.getDate() + 2)
    fetchSoldLineItems({
      branchId: user.branchId,
      startIso: windowStart.toISOString(),
      endIso: windowEnd.toISOString(),
    })
      .then((rows) => {
        if (!active) return
        setSoldItemRows(rows.filter((row) => rowBusinessDate(row, dayOpenHour) === date))
      })
      .catch(() => {
        if (active) setSoldItemRows(null)
      })
    return () => {
      active = false
    }
  }, [user?.branchId, date, dayOpenHour])
  const soldItemsUnavailable = hasSupabase && soldItemRows === null

  const liveReport = useMemo(
    () =>
      buildDayEndReport({
        date,
        transactions,
        soldItemRows: soldItemRows || [],
        products,
        isRestaurant,
        dayOpenHour,
      }),
    [date, transactions, soldItemRows, products, isRestaurant, dayOpenHour],
  )
  const report = isLocked && existing?.dayReport ? existing.dayReport : liveReport

  const buildEntry = () => {
    const dayReport = buildDayEndReport({
      date,
      transactions,
      soldItemRows: soldItemRows || [],
      products,
      isRestaurant,
      dayOpenHour,
    })
    return {
      id: existing?.id,
      date,
      recordedCash: recorded,
      cashOnHand: Number(cashOnHand || 0),
      variance,
      expectedCash,
      note: [note, paidOutTotal ? `Petty cash ${paidOutTotal}` : ''].filter(Boolean).join(' · '),
      cashier: user?.name || 'Staff',
      dayReport: { ...dayReport, pettyCashTotal: paidOutTotal, expectedCash },
    }
  }

  const handleSubmit = async () => {
    setError('')
    if (noteRequired && !note.trim()) {
      setError('A note is required when variance is not zero.')
      setConfirmSubmit(false)
      return
    }
    setBusy(true)
    try {
      await submitDay(buildEntry())
      setConfirmSubmit(false)
    } catch (err) {
      setError(formatSupportError(err, 'TILL02'))
      setConfirmSubmit(false)
    } finally {
      setBusy(false)
    }
  }

  const handleApprove = async () => {
    setError('')
    setBusy(true)
    try {
      await approveDay(existing.id)
      setConfirmApprove(false)
    } catch (err) {
      setError(formatSupportError(err, 'TILL02'))
      setConfirmApprove(false)
    } finally {
      setBusy(false)
    }
  }

  // Undo for a day a supervisor just closed. Manager-only — reopen_day_end() enforces
  // this server-side regardless of what the UI shows, and it stays that way on purpose:
  // closing no longer needs a second person's approval, so this is the one remaining
  // check on a mistaken or disputed close, and it needs a reason on the record.
  const handleReopen = async () => {
    setError('')
    const reason = reopenReason.trim()
    if (!reason) {
      setError('A reason is required to reopen the day.')
      return
    }
    setBusy(true)
    try {
      await reopenDay(existing.id, reason)
      setReopenOpen(false)
      setReopenReason('')
    } catch (err) {
      setError(formatSupportError(err, 'TILL02'))
    } finally {
      setBusy(false)
    }
  }

  // Reason is optional — unlike reopen, this undoes something that never took effect (no
  // numbers were ever recorded, the till never locked), so there is less to explain.
  const handleDecline = async () => {
    setDeclineError('')
    setDeclineBusy(true)
    try {
      await rejectDayRequest(existing.id, declineReason.trim())
      setDeclineOpen(false)
      setDeclineReason('')
    } catch (err) {
      setDeclineError(formatSupportError(err, 'TILL02'))
    } finally {
      setDeclineBusy(false)
    }
  }

  if (loading || (productsLoading && !products.length)) {
    return <PageSkeleton variant="dashboard" />
  }

  return (
    <div>
      <PageHeader eyebrow="CASH CONTROL" title="Day end">
        <span className="text-xs text-brand-n600">
          Business day {date} · opens {formatOpenHourLabel(dayOpenHour)}
        </span>
      </PageHeader>

      {pendingCount > 0 && (
        <div className="mb-3.5 rounded-md bg-brand-warn-bg px-4 py-3 text-xs text-brand-warn">
          {pendingCount} petty cash request{pendingCount === 1 ? '' : 's'} waiting for your
          approval — see the panel below.
        </div>
      )}

      {isSubmitted && (
        <div className="mb-3.5 rounded-md bg-brand-warn-bg px-4 py-3 text-xs text-brand-warn">
          Awaiting supervisor or manager approval. POS sales are locked until the day is approved and
          closed.
          {existing.submittedAt ? ` Submitted at ${existing.submittedAt}.` : ''}
        </div>
      )}

      {isRequested && (
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2 rounded-md bg-brand-warn-bg px-4 py-3 text-xs text-brand-warn">
          <span>
            A cashier requested day end{existing.requestManager ? ' — a manager was specifically asked for' : ''}.
            Count the drawer below and close when ready. Sales stay open until then.
          </span>
          {/* Only whoever could act on this request can also decline it — a plain
              supervisor can't close a manager-specifically-requested day, so they can't
              decline one either. */}
          {!waitingForManager && (
            <SecondaryButton compact type="button" onClick={() => setDeclineOpen(true)}>
              Decline request
            </SecondaryButton>
          )}
        </div>
      )}

      {!isLocked && soldItemsUnavailable ? (
        <TableCard className="mb-3.5 p-5">
          <h2 className="m-0 mb-1 text-base">Today&rsquo;s sales report</h2>
          <p className="m-0 text-xs text-brand-muted">
            Reconnect to see today&rsquo;s sold items and restock suggestions. Cash counting and
            closing the day below are unaffected.
          </p>
        </TableCard>
      ) : (
        <DayEndReportPanels
          report={report}
          title={isClosed ? 'Closed day report' : isSubmitted ? 'Submitted day report' : "Today's sales report"}
          showRestock={!isRestaurant}
        />
      )}

      <TableCard className="mb-3.5 max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Accountability</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          Each cashier counts their own change fund when they start a shift. Record cash pickups
          here during the day — they are charged to whichever shift is open on the drawer.
        </p>

        {/* One line per shift, not one per day. A day total alone cannot answer "whose
            drawer was short", which is the only question this section gets asked.
            Every fact gets its own column: the old single line ("Sup — main · open now
            — ₱0.00 ₱0.00") made a supervisor decode a name, a drawer, a state and two
            unlabelled amounts out of one string. */}
        <div className="mb-4 overflow-hidden rounded-md border border-brand-softline">
          <div className="border-b border-brand-softline px-3 py-2.5">
            <strong className="block text-xs text-brand-ink">Change fund by shift</strong>
            <p className="m-0 text-[11px] text-brand-subtle">
              Counted by each cashier at the start of their shift · total today{' '}
              {money(changeFundTotal)}
            </p>
          </div>
          {drawerShifts.length === 0 && changeFundRows.length === 0 ? (
            <p className="m-0 px-3 py-4 text-xs text-brand-subtle">
              No shift has been opened on this business day yet.
            </p>
          ) : (
            <>
              <div className={`grid ${FUND_GRID} ${FUND_GRID_NARROW} items-center gap-2 bg-brand-dark px-3 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase`}>
                <span>Cashier</span>
                <span className="max-[700px]:hidden">Drawer / terminal</span>
                <span>Shift status</span>
                <span className="text-right max-[700px]:hidden">Opening float</span>
                <span className="text-right max-[700px]:hidden">Closing cash</span>
                <span className="text-right">Variance</span>
              </div>
              {drawerShifts.map((row) => {
                const status = shiftStatusBadge(row)
                return (
                  <div
                    key={row.id}
                    className={`grid ${FUND_GRID} ${FUND_GRID_NARROW} items-center gap-2 border-t border-brand-softline px-3 py-2.5 text-xs`}
                  >
                    <div className="min-w-0">
                      <strong className="block truncate text-brand-ink">{row.staffName}</strong>
                      <small className="block truncate text-[10px] text-brand-subtle capitalize">
                        {row.staffRole || 'staff'}
                        {row.shiftPeriod ? ` · ${row.shiftPeriod.toUpperCase()}` : ''}
                      </small>
                      <small className="mt-0.5 hidden text-[10px] text-brand-subtle max-[700px]:block">
                        {row.drawerLabel || row.drawerId} · float {money(row.startingCash)}
                      </small>
                    </div>
                    <span className="truncate text-brand-muted max-[700px]:hidden">
                      {row.drawerLabel || row.drawerId}
                    </span>
                    <span>
                      <StatusBadge compact tone={status.tone} title={status.hint}>
                        {status.label}
                      </StatusBadge>
                      {/* A cashier stuck on a "your shift is open on another till" gate
                          cannot see or close it themselves (ShiftGate) — freed from here
                          instead, by whoever is already looking at this business day. */}
                      {row.open && (
                        <button
                          type="button"
                          className="mt-0.5 block border-0 bg-transparent text-[10px] font-bold text-brand-ink underline underline-offset-2"
                          onClick={() => {
                            setClosingError('')
                            setClosingShift(row)
                          }}
                        >
                          Close shift
                        </button>
                      )}
                    </span>
                    <strong className={`text-right max-[700px]:hidden ${moneyClass}`}>
                      {money(row.startingCash)}
                    </strong>
                    <span className={`text-right max-[700px]:hidden ${moneyClass}`}>
                      {row.endingCash == null ? '—' : money(row.endingCash)}
                    </span>
                    <strong className={`text-right ${moneyClass} ${varianceToneClass(row.variance)}`}>
                      {/* An open shift has no variance yet — it is not zero, it is not
                          known. Printing ₱0.00 would read as "balanced". */}
                      {row.open || row.variance == null ? '—' : money(row.variance)}
                    </strong>
                  </div>
                )
              })}
              {changeFundRows.map((row) => (
                <div
                  key={row.id}
                  className="flex justify-between border-t border-brand-softline px-3 py-2.5 text-xs"
                >
                  <span className="text-brand-subtle">Opening float (recorded before shifts)</span>
                  <strong className={moneyClass}>{money(row.amount)}</strong>
                </div>
              ))}
            </>
          )}
        </div>

        {!isLocked && (
          <div className="mb-4 rounded-md border border-brand-softline p-3">
            <strong className="block text-xs text-brand-ink">Cash pickup</strong>
            <p className="m-0 mb-2 text-[11px] text-brand-subtle">Move cash out of drawer for safekeeping</p>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 max-[700px]:grid-cols-1">
              <Field
                label="Amount"
                value={pickupAmount}
                onChange={(e) => setPickupAmount(decimalOnly(e.target.value))}
                inputMode="decimal"
              />
              <Field
                label="Note"
                value={pickupNote}
                onChange={(e) => setPickupNote(e.target.value.replace(/[<>]/g, ''))}
              />
              <div className="flex items-end">
                <PrimaryButton
                  compact
                  type="button"
                  disabled={!pickupAmount || Number(pickupAmount) <= 0}
                  onClick={async () => {
                    const reason = `[PICKUP] ${pickupNote || 'Safe drop'}`.trim()
                    try {
                      if (hasSupabase && user?.branchId) {
                        await addPettyCash({
                          branchId: user.branchId,
                          staffId: user.id,
                          amount: Number(pickupAmount),
                          reason,
                          businessDate: date,
                          kind: 'pickup',
                          status: 'recorded',
                          // Charged to the shift holding the drawer, so it lands in that
                          // cashier's expected cash rather than only the day's.
                          shiftId: drawerHolderShift?.id || null,
                        })
                        await reload()
                      }
                      setPickupAmount('')
                      setPickupNote('')
                    } catch (err) {
                      setError(formatSupportError(err, 'PETTY01'))
                    }
                  }}
                >
                  Record
                </PrimaryButton>
              </div>
            </div>
            {pickupRows.length > 0 && (
              <div className="mt-2">
                {pickupRows.map((row) => (
                  <div
                    key={row.id}
                    className="flex justify-between border-t border-brand-softline py-1.5 text-xs"
                  >
                    <span>{row.reason?.replace(/^\[PICKUP\]\s*/i, '') || 'Pickup'}</span>
                    <strong className={moneyClass}>{money(row.amount)}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <p className="mb-0 text-xs text-brand-muted">
          Float {money(changeFundTotal)} · Pickups {money(pickupTotal)} · Handed-out{' '}
          {money(paidOutTotal)}
        </p>
      </TableCard>

      <PettyCashPanel
        rows={paidOutRows}
        user={user}
        branchId={user?.branchId}
        businessDate={date}
        shiftId={drawerHolderShift?.id || null}
        canApprove
        canRequest
        locked={isLocked}
        scope="branch"
        onChanged={reload}
      />

      {/* Close day sits last, after the sales report, shift accountability, and petty cash
          queue above — a supervisor has to scroll past everything worth checking before
          reaching the button that locks the day, instead of being able to close it first
          and read the rest after. */}
      <TableCard className="mb-3.5 grid max-h-none gap-4 p-5">
        <div className="grid grid-cols-3 gap-3.5 max-[900px]:grid-cols-1">
          <div>
            <span className="block text-[11px] text-brand-subtle">All sales (POS)</span>
            <strong className={`my-2 block text-[22px] ${moneyClass} text-brand-gold`}>{money(recorded)}</strong>
            <small className="block text-[11px] text-brand-subtle">
              Cash {money(cashSales)} · Card {money(cardSales)} · E-wallet {money(ewalletSales)}
            </small>
          </div>
          <Field
            label="Cash on hand"
            inputMode="decimal"
            value={cashOnHand}
            onChange={(event) => setCashOnHand(decimalOnly(event.target.value))}
            placeholder="0.00"
            disabled={isLocked || waitingForManager}
          />
          <div>
            <span className="block text-[11px] text-brand-subtle">Variance vs expected</span>
            <strong
              className={`my-2 block text-[22px] ${moneyClass} ${
                hasCashOnHand ? varianceToneClass(variance) : 'text-brand-subtle'
              }`}
            >
              {hasCashOnHand ? money(variance) : '—'}
            </strong>
            <small className="block text-[11px] text-brand-subtle">
              {hasCashOnHand
                ? `${variance === 0 ? 'Balanced' : variance < 0 ? 'Short' : 'Over'} (after petty cash)`
                : 'Enter cash on hand to compare'}
            </small>
          </div>
        </div>

        {/* How "Expected" is derived — spelled out instead of packed into one line, since
            this is the number cash on hand gets checked against. */}
        <div className="grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-1.5 rounded-md border border-brand-softline px-3.5 py-3 text-[13px]">
          <span className="text-brand-subtle">Change fund (float)</span>
          <strong className={`text-right ${moneyClass}`}>{money(changeFundTotal)}</strong>
          <span className="text-brand-subtle">+ Cash sales</span>
          <strong className={`text-right ${moneyClass}`}>{money(cashSales)}</strong>
          {cashDiscounts > 0 && (
            <span className="col-span-2 -mt-1 text-[11px] text-brand-subtle">
              ({money(cashSalesGross)} before discounts − {money(cashDiscounts)} in discounts —
              already reflected in Cash sales above, not deducted again)
            </span>
          )}
          <span className="text-brand-subtle">− Paid out (handed over)</span>
          <strong className={`text-right ${moneyClass}`}>−{money(paidOutTotal)}</strong>
          <span className="text-brand-subtle">− Pickups to safe</span>
          <strong className={`text-right ${moneyClass}`}>−{money(pickupTotal)}</strong>
          <span className="border-t border-brand-softline pt-1.5 font-bold">
            = Expected in drawer
          </span>
          <strong className={`border-t border-brand-softline pt-1.5 text-right font-bold ${moneyClass}`}>
            {money(expectedCash)}
          </strong>
        </div>
        {approvedUnfulfilled > 0 && (
          <p className="m-0 rounded-md bg-brand-n50 px-3 py-2 text-[11px] text-brand-muted">
            {money(approvedUnfulfilled)} of approved petty cash has not been handed over yet, so it
            is still counted as being in the drawer.
          </p>
        )}
        <Field
          label={noteRequired ? 'Notes (required — variance not zero)' : 'Notes'}
          value={note}
          onChange={(event) => setNote(event.target.value.replace(/[<>]/g, ''))}
          placeholder={noteRequired ? 'Explain the variance' : 'Optional note'}
          disabled={isLocked || waitingForManager}
        />
        {error && <p className="text-xs text-brand-danger">{error}</p>}
        {isClosed ? (
          <div>
            <p className="text-[13px] text-brand-muted">
              Day closed{existing.approvedAt ? ` at ${existing.approvedAt}` : existing.closedAt ? ` at ${existing.closedAt}` : ''}{' '}
              by {existing.cashier || 'staff'}. POS sales are locked until a manager reopens, or until{' '}
              {formatOpenHourLabel(dayOpenHour)} starts the next business day.
              {!isRestaurant && report?.restock?.length
                ? ` Restock list (${report.restock.length}) will show on the next open.`
                : ''}
            </p>
            {isManager && (
              <SecondaryButton
                compact
                type="button"
                className="mt-3"
                disabled={busy}
                onClick={() => setReopenOpen(true)}
              >
                Cancel closing
              </SecondaryButton>
            )}
          </div>
        ) : isSubmitted ? (
          <div>
            <p className="mb-3 text-[13px] text-brand-muted">
              Counts are locked while awaiting approval. A supervisor or manager must approve and close
              the day.
            </p>
            {canApprove && (
              <PrimaryButton compact disabled={busy} onClick={() => setConfirmApprove(true)}>
                Approve &amp; close day
              </PrimaryButton>
            )}
          </div>
        ) : (
          <div>
            {existing?.status === 'reopened' && (
              <p className="mb-3 text-xs text-brand-warn">
                Till was reopened by a manager
                {existing.reopenedAt ? ` at ${existing.reopenedAt}` : ''}
                {existing.reopenReason ? `: ${existing.reopenReason}` : ''}. Submit again when ready.
              </p>
            )}
            {waitingForManager ? (
              <p className="text-[13px] text-brand-muted">
                A cashier requested day end and specifically asked for a manager — waiting for
                one to count the drawer and close.
              </p>
            ) : (
              <>
                {/* Closing is the Z-reading gate, so it is supervisor+ only — consistent with
                    where Z-readings are generated elsewhere in the app. It closes immediately:
                    the person on this screen already IS the approval, so there is no separate
                    approve step to wait on (see migrate_day_end_supervisor_autoclose.sql). A
                    manager can still undo it with Cancel closing if something was miskeyed. */}
                <PrimaryButton
                  compact
                  disabled={cashOnHand === '' || (noteRequired && !note.trim())}
                  onClick={() => setConfirmSubmit(true)}
                >
                  Close day
                </PrimaryButton>
              </>
            )}
          </div>
        )}
      </TableCard>

      {confirmSubmit && (
        <Modal wide onClose={() => setConfirmSubmit(false)}>
          <Eyebrow>CLOSE DAY</Eyebrow>
          <h2 className="mb-3 text-[22px] max-[700px]:text-lg">Close {date}?</h2>
          <p className="mb-2 text-xs text-brand-muted">
            This locks POS sales until a manager reopens the day or the next business day
            starts. The sales report
            {!isRestaurant ? ' and restock list' : ''} will be saved with your counts.
          </p>
          <div className="my-3 grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2.5 border-y border-brand-n300 py-3.5 text-[13px]">
            <span>Recorded</span>
            <strong className={`text-right ${moneyClass}`}>{money(recorded)}</strong>
            <span>Petty cash handed over</span>
            <strong className={`text-right ${moneyClass}`}>{money(paidOutTotal)}</strong>
            <span>Expected drawer</span>
            <strong className={`text-right ${moneyClass}`}>{money(expectedCash)}</strong>
            <span>Cash on hand</span>
            <strong className={`text-right ${moneyClass}`}>{money(Number(cashOnHand || 0))}</strong>
            <span>Variance</span>
            <strong className={`text-right ${moneyClass} ${varianceToneClass(variance)}`}>
              {money(variance)}
            </strong>
            <span>Line items sold</span>
            <strong className="text-right">{liveReport.sold.length}</strong>
            {!isRestaurant && (
              <>
                <span>Restock flags</span>
                <strong className="text-right text-brand-danger">{liveReport.restock.length}</strong>
              </>
            )}
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setConfirmSubmit(false)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={handleSubmit}>
              {busy ? 'Closing…' : 'Close day'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {reopenOpen && (
        <Modal onClose={() => !busy && setReopenOpen(false)}>
          <Eyebrow>CANCEL CLOSING</Eyebrow>
          <h2 className="mb-2 text-lg">Reopen {date}?</h2>
          <p className="m-0 text-xs text-brand-muted">
            POS sales unlock again for this business day. The close stays on record — this adds
            a reopen entry with your reason, it does not erase what was submitted.
          </p>
          <Field
            className="mt-3"
            label="Reason (required)"
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value.replace(/[<>]/g, ''))}
            placeholder="Why is this being reopened?"
            required
          />
          {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setReopenOpen(false)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy || !reopenReason.trim()} onClick={handleReopen}>
              {busy ? 'Reopening…' : 'Reopen day'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {declineOpen && (
        <Modal onClose={() => !declineBusy && setDeclineOpen(false)}>
          <Eyebrow>DECLINE REQUEST</Eyebrow>
          <h2 className="mb-2 text-lg">Decline this day-end request?</h2>
          <p className="m-0 text-xs text-brand-muted">
            The cashier who requested it will see the request form again — nothing is counted
            or locked, so this is safe if the request was made by mistake.
          </p>
          <Field
            className="mt-3"
            label="Reason (optional)"
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value.replace(/[<>]/g, ''))}
            placeholder="Why is this being declined?"
          />
          {declineError && <p className="mt-2 text-xs text-brand-danger">{declineError}</p>}
          <ModalActions>
            <SecondaryButton compact type="button" disabled={declineBusy} onClick={() => setDeclineOpen(false)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={declineBusy} onClick={handleDecline}>
              {declineBusy ? 'Declining…' : 'Decline request'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {confirmApprove && (
        <Modal wide onClose={() => setConfirmApprove(false)}>
          <Eyebrow>APPROVE DAY CLOSE</Eyebrow>
          <h2 className="mb-3 text-[22px] max-[700px]:text-lg">Approve &amp; close {date}?</h2>
          <p className="mb-2 text-xs text-brand-muted">
            This finalizes the day close. POS stays locked until a manager reopens or the next business
            day begins.
          </p>
          <div className="my-3 grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2.5 border-y border-brand-n300 py-3.5 text-[13px]">
            <span>Cash on hand</span>
            <strong className={`text-right ${moneyClass}`}>{money(existing?.cashOnHand ?? 0)}</strong>
            <span>Variance</span>
            <strong className={`text-right ${moneyClass} ${varianceToneClass(existing?.variance)}`}>
              {money(existing?.variance ?? 0)}
            </strong>
            {existing?.note && (
              <>
                <span>Note</span>
                <span className="text-right text-brand-muted">{existing.note}</span>
              </>
            )}
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setConfirmApprove(false)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={handleApprove}>
              Approve &amp; close day
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {closingShift && (
        <Modal onClose={() => !closingBusy && setClosingShift(null)}>
          <Eyebrow>CLOSE SHIFT</Eyebrow>
          <h2 className="mb-2 text-lg">Close {closingShift.staffName}&apos;s shift?</h2>
          <p className="m-0 text-xs text-brand-muted">
            Ends it on {closingShift.drawerLabel || closingShift.drawerId} with no count — the
            drawer is counted once at Day End, not per shift. They&apos;ll need to sign in
            again to start a new one.
          </p>
          {closingError && <p className="mt-2 text-xs text-brand-danger">{closingError}</p>}
          <ModalActions>
            <SecondaryButton compact type="button" disabled={closingBusy} onClick={() => setClosingShift(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={closingBusy}
              onClick={async () => {
                setClosingBusy(true)
                setClosingError('')
                try {
                  await closeShift({
                    shiftId: closingShift.serverId || closingShift.id,
                    closedBy: user?.id || null,
                  })
                  setClosingShift(null)
                  await reload()
                } catch (err) {
                  setClosingError(formatSupportError(err, 'SHIFT02'))
                } finally {
                  setClosingBusy(false)
                }
              }}
            >
              {closingBusy ? 'Closing…' : 'Close shift'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}

export default DayEnd
