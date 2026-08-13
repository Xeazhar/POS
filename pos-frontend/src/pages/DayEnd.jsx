import { useEffect, useMemo, useState } from 'react'
import { DayEndReportPanels } from '../components/dayend/DayEndReportPanels'
import DrawerActivity, { unapprovedMovementBannerText } from '../components/dayend/DrawerActivity'
import OwnShiftSoFar from '../components/dayend/OwnShiftSoFar'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PageSkeleton,
  PrimaryButton,
  SecondaryButton,
  TableCard,
  moneyClass,
  varianceToneClass,
} from '../components/ui'
import {
  closeShift,
  CASH_MOVEMENT_COUNTING_STATUSES,
  fetchCashMovements,
  fetchPettyCash,
  fetchSoldLineItems,
  fetchStaffShifts,
  hasSupabase,
  receiveShiftHandoff,
} from '../lib/api'
import { useLiveData } from '../hooks/useLiveData'
import { isOnline, listLocalCashMovements } from '../offline'
import { listLocalShifts } from '../offline/shifts'
import { withTimeout } from '../utils/withTimeout'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { useShiftStore } from '../stores/shiftStore'
import { buildDayEndReport } from '../utils/dayEndReport'
import { formatSupportError } from '../utils/errors'
import {
  businessDate,
  dayEndForBusinessDate,
  formatOpenHourLabel,
  money,
  rowBusinessDate,
} from '../utils/format'
import { isManagerRole, isSupervisorOrAbove, usesPinLogin } from '../utils/roles'
import { decimalOnly } from '../utils/validate'

const rowKind = (row) =>
  row.kind ||
  (String(row.reason || '').startsWith('[CHANGE FUND]')
    ? 'change_fund'
    : String(row.reason || '').startsWith('[PICKUP]')
      ? 'pickup'
      : 'paid_out')

const rowStatus = (row) => row.status || (rowKind(row) === 'paid_out' ? 'fulfilled' : 'recorded')

/**
 * Counts cash-movement rows recorded by the current user that still require review.
 * @param {Array<Object>} rows - Cash-movement rows to inspect.
 * @return {number} The number of rows with a `self_recorded` status.
 */
function countUnreviewedSelfRecorded(rows = []) {
  return rows.filter((r) => r.status === 'self_recorded').length
}

/**
 * Expected drawer for a shift from its recorded components (float + sales − outs).
 * Used when acknowledging a cashier handoff that closed with no per-shift count.
 */
function shiftExpectedCash(row) {
  if (row?.expectedCash != null) return Number(row.expectedCash)
  return Number(
    (
      Number(row?.startingCash || 0) +
      Number(row?.cashSales || 0) -
      Number(row?.cashRefunds || 0) -
      Number(row?.cashPaidOut || 0) -
      Number(row?.cashPickups || 0)
    ).toFixed(2),
  )
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

/**
 * Loads petty cash, staff shifts, and cash movements for a business date.
 * @param {Object} user - Current user context, including the branch identifier.
 * @param {string} date - Business date used to scope the data.
 * @param {Object} [options] - Optional filters for a shift or staff member.
 * @param {string|null} [options.shiftServerId=null] - Server identifier of a shift to include.
 * @param {string|null} [options.staffId=null] - Staff identifier whose requested movements should be included.
 * @returns {{petty: Array, shifts: Array, movements: Array, loading: boolean, reload: Function}} The loaded petty cash records, shifts, cash movements, loading state, and reload function.
 */
function useDayEndData(user, date, { shiftServerId = null, staffId = null } = {}) {
  const [petty, setPetty] = useState([])
  const [shifts, setShifts] = useState([])
  const [movements, setMovements] = useState([])
  const [loading, setLoading] = useState(Boolean(hasSupabase && user?.branchId))
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)

  const reload = async () => {
    if (!hasSupabase || !user?.branchId) {
      setPetty([])
      setShifts([])
      setMovements([])
      return
    }

    if (!isOnline()) {
      const shiftRows = await listLocalShifts({ branchId: user.branchId, businessDate: date })
      setShifts(shiftRows || [])
      const fromShifts = (shiftRows || []).map((s) => s.serverId || s.clientId || s.id).filter(Boolean)
      const shiftIds = [...new Set([shiftServerId, ...fromShifts].filter(Boolean))]
      const localMoves = await listLocalCashMovements({
        branchId: user.branchId,
        date,
        staffId,
        shiftIds,
      })
      setMovements(localMoves)
      setPetty(localMoves.filter((row) => row.type === 'petty_cash'))
      return
    }

    const [pettyRows, shiftRows] = await Promise.all([
      withTimeout(fetchPettyCash(user.branchId, date), 15000, 'Petty cash').catch(() => []),
      withTimeout(fetchStaffShifts({ branchId: user.branchId, start: date, end: date }), 15000, 'Shifts').catch(
        () => [],
      ),
    ])
    setPetty(pettyRows || [])
    setShifts(shiftRows || [])
    const fromShifts = (shiftRows || []).map((s) => s.serverId || s.id).filter(Boolean)
    const shiftIds = [...new Set([shiftServerId, ...fromShifts].filter(Boolean))]
    // Always scope to this business date. byShift/byRequester without dates used to
    // leak yesterday's petty/pickups into Drawer Activity (and inflate Expected).
    const dayScope = { start: date, end: date }
    const [byDate, byShift, byRequester] = await Promise.all([
      withTimeout(
        fetchCashMovements({
          branchId: user.branchId,
          ...dayScope,
        }),
        15000,
        'Cash movements',
      ).catch(() => []),
      shiftIds.length
        ? withTimeout(
            fetchCashMovements({ branchId: user.branchId, shiftIds, ...dayScope }),
            15000,
            'Shift movements',
          ).catch(() => [])
        : Promise.resolve([]),
      staffId
        ? withTimeout(
            fetchCashMovements({
              branchId: user.branchId,
              requestedBy: staffId,
              ...dayScope,
            }),
            15000,
            'Cashier movements',
          ).catch(() => [])
        : Promise.resolve([]),
    ])
    const byId = new Map()
    for (const row of [...(byDate || []), ...(byShift || []), ...(byRequester || [])]) {
      if (!row?.id) continue
      if (rowBusinessDate({ createdAt: row.requestedAt || row.createdAt }, dayOpenHour) !== date) {
        continue
      }
      byId.set(row.id, row)
    }
    setMovements(
      [...byId.values()].sort((a, b) =>
        String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')),
      ),
    )
  }

  useEffect(() => {
    let active = true
    if (!hasSupabase || !user?.branchId) {
      setPetty([])
      setShifts([])
      setMovements([])
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
  }, [user?.branchId, date, shiftServerId, staffId])

  useLiveData({
    enabled: hasSupabase && Boolean(user?.branchId),
    fetch: reload,
    broadcasts: user?.branchId
      ? [
          {
            topic: `pos:branch:${user.branchId}:operations`,
            events: ['OPERATIONS_CHANGED'],
          },
        ]
      : [],
    pollMs: 15_000,
  })

  useEffect(() => {
    const onMove = () => {
      void reload().catch(() => {})
    }
    window.addEventListener('cale-cash-movements-changed', onMove)
    window.addEventListener('focus', onMove)
    return () => {
      window.removeEventListener('cale-cash-movements-changed', onMove)
      window.removeEventListener('focus', onMove)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.branchId, date, shiftServerId, staffId])

  return { petty, shifts, movements, loading, reload }
}

/**
 * Displays the cashier's shift activity and day-end request controls for their own drawer.
 * @return {JSX.Element} The cashier end-of-shift view.
 */
function CashierEndShift() {
  const user = useAuthStore((state) => state.user)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const date = businessDate(new Date(), dayOpenHour)
  const shift = useShiftStore((state) => state.shift)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const requestDay = useInventoryStore((state) => state.requestDay)

  const { movements, loading, reload } = useDayEndData(user, date, {
    shiftServerId: shift?.serverId || null,
    staffId: user?.id || null,
  })
  const [requestManagerToggle, setRequestManagerToggle] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [requestError, setRequestError] = useState('')

  if (loading) return <PageSkeleton variant="dashboard" />

  const todayEntry = dayEndForBusinessDate(dayEnds, date)
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

      <OwnShiftSoFar user={user} movements={movements} onReload={reload} />

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
    </div>
  )
}

/**
 * Provides branch-wide day-end oversight for supervisors and managers.
 * @returns {JSX.Element} The day-end dashboard with sales, drawer accountability, cash variance, and close controls.
 */
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
  const trackOwnShift = usesPinLogin(user?.role)

  const date = businessDate(new Date(), dayOpenHour)
  const { petty, shifts, movements, loading, reload } = useDayEndData(user, date)

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

  // Draft only — never pre-fill from a prior count or a reopened row; supervisor must
  // count fresh each visit. Cleared again on unmount so leaving Day end never carries over.
  const [cashOnHandDraft, setCashOnHandDraft] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const countingActive = !isSubmitted && !isClosed && !waitingForManager
  const cashOnHand = countingActive ? cashOnHandDraft : String(existing?.cashOnHand ?? '')
  const note = countingActive ? noteDraft : existing?.note || ''

  useEffect(() => {
    setCashOnHandDraft('')
    setNoteDraft('')
  }, [date])
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
  const [closingShift, setClosingShift] = useState(null)
  const [closingBusy, setClosingBusy] = useState(false)
  const [closingError, setClosingError] = useState('')
  const [receivingHandoff, setReceivingHandoff] = useState(false)
  const [handoffError, setHandoffError] = useState('')
  const [openReviewNonce, setOpenReviewNonce] = useState(0)

  const ownShift = useShiftStore((state) => state.shift)

  const changeFundRows = petty.filter((row) => rowKind(row) === 'change_fund')
  const pickupRows = petty.filter((row) => rowKind(row) === 'pickup')
  const paidOutRows = petty.filter((row) => rowKind(row) === 'paid_out')

  // The change fund now lives on the shift that counted it (starting_cash), one per
  // cashier per drawer. The legacy cash_drawer_entries rows are still added in for days
  // recorded before migrate_shift_cash_accountability.sql — the two never overlap, because
  // the new flow writes no change_fund entry at all.
  const drawerShifts = shifts.filter((row) => row.holdsDrawer !== false)
  const openDrawerShifts = drawerShifts.filter((row) => row.open)
  const pendingHandoffs = drawerShifts.filter(
    (row) => !row.open && row.endingCash == null,
  )
  // Whoever is actually holding the drawer right now — NOT the viewing supervisor's own
  // shift (`ownShift`). A supervisor recording a pickup or requesting petty cash from
  // this screen is usually a different person than the cashier on the till, often with no
  // drawer shift of their own at all. Attributing to `ownShift` silently charged the
  // entry to the wrong shift (or none), so the cashier's shift-scoped RPC never saw it while
  // this page's own day-wide total did — a real source of "cashier and supervisor numbers
  // don't match" independent of shift count.
  const drawerHolderShift = drawerShifts.find((row) => row.open)
  const shiftFloatTotal = drawerShifts.reduce((sum, row) => sum + Number(row.startingCash || 0), 0)
  const legacyFloatTotal = changeFundRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const changeFundTotal = shiftFloatTotal + legacyFloatTotal
  const pickupTotal = pickupRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const countingMoves = movements.filter((m) =>
    CASH_MOVEMENT_COUNTING_STATUSES.includes(m.status),
  )
  const movePaidOutTotal = countingMoves
    .filter((m) => m.type === 'petty_cash')
    .reduce((sum, m) => sum + Number(m.amount || 0), 0)
  const movePickupTotal = countingMoves
    .filter((m) => m.type === 'pickup')
    .reduce((sum, m) => sum + Number(m.amount || 0), 0)

  // Only cash that has actually been handed over leaves the drawer. An approved request
  // still sitting in the till is a commitment, not a disbursement — deducting it here made
  // the drawer read short for as long as it went unfulfilled.
  const paidOutTotal = paidOutRows
    .filter((row) => rowStatus(row) === 'fulfilled')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const approvedUnfulfilled = paidOutRows
    .filter((row) => rowStatus(row) === 'approved')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)

  const moveCashInTotal = countingMoves
    .filter((m) => m.type === 'cash_in')
    .reduce((sum, m) => sum + Number(m.amount || 0), 0)

  const expectedCash = Number(
    (
      changeFundTotal +
      moveCashInTotal +
      cashSales -
      paidOutTotal -
      pickupTotal -
      movePaidOutTotal -
      movePickupTotal
    ).toFixed(2),
  )
  // An untouched field is "not yet counted", not "counted as ₱0.00" — treating it as zero
  // showed a false "Short" the instant this screen loaded, before anyone had counted anything.
  const hasCashOnHand = countingActive ? cashOnHandDraft !== '' : cashOnHand !== ''
  const variance = countingActive
    ? Number(cashOnHandDraft || 0) - expectedCash
    : Number(existing?.variance ?? Number(cashOnHand || 0) - expectedCash)
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
      cashOnHand: Number(countingActive ? cashOnHandDraft : cashOnHand || 0),
      variance,
      expectedCash,
      note: [note, paidOutTotal ? `Petty cash ${paidOutTotal}` : ''].filter(Boolean).join(' · '),
      cashier: user?.name || 'Staff',
      dayReport: { ...dayReport, pettyCashTotal: paidOutTotal, expectedCash },
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

  const receiveAllHandoffs = async () => {
    if (!pendingHandoffs.length) return
    setReceivingHandoff(true)
    setHandoffError('')
    try {
      for (const row of pendingHandoffs) {
        await receiveShiftHandoff({
          shiftId: row.serverId || row.id,
          receivedBy: user?.id || null,
        })
      }
      await reload()
    } catch (err) {
      setHandoffError(formatSupportError(err, 'SHIFT05'))
    } finally {
      setReceivingHandoff(false)
    }
  }

  // Same order as cashier: end own floor shift → receive cashier handoffs → close day.
  const ownShiftOpen = trackOwnShift && Boolean(ownShift)
  const unreviewedMoves = countUnreviewedSelfRecorded(movements)
  const closeDayBlockedReason = ownShiftOpen
    ? 'End your own shift first — Close day unlocks after you clock out.'
    : openDrawerShifts.length
      ? `Close ${openDrawerShifts.length} open cashier shift${openDrawerShifts.length === 1 ? '' : 's'} first (Accountability above).`
      : pendingHandoffs.length
        ? `Confirm received handoff for ${pendingHandoffs.length} cashier shift${pendingHandoffs.length === 1 ? '' : 's'} first.`
        : unreviewedMoves
          ? unapprovedMovementBannerText(unreviewedMoves)
          : ''

  const handleSubmit = async () => {
    setError('')
    if (countUnreviewedSelfRecorded(movements) > 0) {
      setError(unapprovedMovementBannerText(countUnreviewedSelfRecorded(movements)))
      setConfirmSubmit(false)
      setOpenReviewNonce((n) => n + 1)
      return
    }
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

      {!isLocked && unreviewedMoves > 0 && (
        <button
          type="button"
          className="mb-3.5 block w-full rounded-[10px] border border-brand-warn bg-brand-warn-bg px-4 py-3 text-left text-sm font-bold text-brand-warn hover:brightness-95"
          onClick={() => setOpenReviewNonce((n) => n + 1)}
        >
          {unapprovedMovementBannerText(unreviewedMoves)}
          <span className="mt-1 block text-[11px] font-normal">
            Tap to Confirm or Flag — only a supervisor/manager who did not request the movement
            can act. Close day stays locked until every unauthorized row is reviewed.
          </span>
        </button>
      )}

      {trackOwnShift && (
        <OwnShiftSoFar
          user={user}
          movements={movements}
          onReload={reload}
          onShiftEnded={() => void reload()}
          drawerTitle="Your drawer activity"
          drawerSubtitle="Movements on your shift only. Branch-wide Drawer Activity for review is below."
        />
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
          Opening float total today {money(changeFundTotal)}. Cash leaving the drawer is created
          only from POS → Open Drawer (Drawer Activity below).
        </p>

        {/* Slim open-shift list only — full change-fund-by-shift tracker removed; float
            math still feeds Expected drawer below via changeFundTotal. */}
        {!isLocked && openDrawerShifts.length > 0 && (
          <div className="mb-4 overflow-hidden rounded-md border border-brand-softline">
            <div className="border-b border-brand-softline px-3 py-2.5">
              <strong className="block text-xs text-brand-ink">Open cashier shifts</strong>
              <p className="m-0 text-[11px] text-brand-subtle">
                Close these before Received handoff / Close day.
              </p>
            </div>
            {openDrawerShifts.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-brand-softline px-3 py-2.5 text-xs"
              >
                <div className="min-w-0">
                  <strong className="block truncate text-brand-ink">{row.staffName}</strong>
                  <small className="block truncate text-[10px] text-brand-subtle">
                    {row.drawerLabel || row.drawerId}
                    {row.shiftPeriod ? ` · ${row.shiftPeriod.toUpperCase()}` : ''}
                  </small>
                </div>
                <button
                  type="button"
                  className="shrink-0 border-0 bg-transparent text-[11px] font-bold text-brand-ink underline underline-offset-2"
                  onClick={() => {
                    setClosingError('')
                    setClosingShift(row)
                  }}
                >
                  Close shift
                </button>
              </div>
            ))}
          </div>
        )}

        {pickupRows.length > 0 && (
          <div className="mb-4">
            <strong className="mb-1 block text-[11px] text-brand-subtle">
              Legacy pickups (before Open Drawer)
            </strong>
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
        <p className="mb-0 text-xs text-brand-muted">
          Float {money(changeFundTotal)} · Pickups {money(pickupTotal + movePickupTotal)} ·
          Handed-out {money(paidOutTotal + movePaidOutTotal)}
        </p>
      </TableCard>

      <DrawerActivity
        rows={movements}
        expectedCash={expectedCash}
        canReview={!isLocked && isSupervisorOrAbove(user?.role)}
        currentUserId={user?.id}
        onReviewed={reload}
        openReviewNonce={openReviewNonce}
        showInlineBanner={false}
        subtitle="Branch-wide petty cash and pickups from POS → Open Drawer. Unauthorized rows must be Confirmed or Flagged before Close day."
      />

      {(!isLocked || isSubmitted) && pendingHandoffs.length > 0 && (
        <TableCard className="mb-3.5 max-h-none p-5">
          <h2 className="m-0 mb-1 text-base">Received handoff</h2>
          <p className="m-0 mb-3 text-xs text-brand-muted">
            Cashier(s) ended their shift and handed the drawer over. Confirm receipt before
            {isSubmitted ? ' approving' : ' counting cash on hand and closing'} the day —
            clears Pending handoff on Staff → Shifts.
          </p>
          <ul className="m-0 mb-3 list-disc space-y-1 pl-5 text-xs text-brand-muted">
            {pendingHandoffs.map((row) => (
              <li key={row.id}>
                {row.staffName} · {row.drawerLabel || row.drawerId} · expected{' '}
                {money(shiftExpectedCash(row))}
              </li>
            ))}
          </ul>
          {handoffError && <p className="mb-2 text-xs text-brand-danger">{handoffError}</p>}
          <PrimaryButton
            compact
            type="button"
            disabled={receivingHandoff || ownShiftOpen || openDrawerShifts.length > 0}
            onClick={() => void receiveAllHandoffs()}
          >
            {receivingHandoff ? 'Confirming…' : `Confirm received handoff (${pendingHandoffs.length})`}
          </PrimaryButton>
          {(ownShiftOpen || openDrawerShifts.length > 0) && (
            <p className="mt-2 mb-0 text-[11px] text-brand-subtle">
              {ownShiftOpen
                ? 'End your own shift first.'
                : 'Close open cashier shifts first (Accountability above).'}
            </p>
          )}
        </TableCard>
      )}

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
            onChange={(event) => setCashOnHandDraft(decimalOnly(event.target.value))}
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
          onChange={(event) => setNoteDraft(event.target.value.replace(/[<>]/g, ''))}
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
              <>
                {pendingHandoffs.length > 0 && (
                  <p className="mb-2 text-[11px] text-brand-warn">
                    Confirm received handoff for {pendingHandoffs.length} shift
                    {pendingHandoffs.length === 1 ? '' : 's'} before approving (card above).
                  </p>
                )}
                <PrimaryButton
                  compact
                  disabled={busy || pendingHandoffs.length > 0 || ownShiftOpen}
                  onClick={() => setConfirmApprove(true)}
                >
                  Approve &amp; close day
                </PrimaryButton>
              </>
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
                  disabled={
                    cashOnHandDraft === '' ||
                    (noteRequired && !note.trim()) ||
                    Boolean(closeDayBlockedReason)
                  }
                  title={closeDayBlockedReason || undefined}
                  onClick={() => setConfirmSubmit(true)}
                >
                  Close day
                </PrimaryButton>
                {closeDayBlockedReason && (
                  <p className="mt-2 mb-0 text-[11px] text-brand-subtle">{closeDayBlockedReason}</p>
                )}
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
            <strong className={`text-right ${moneyClass}`}>{money(Number(cashOnHandDraft || 0))}</strong>
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
            Ends it on {closingShift.drawerLabel || closingShift.drawerId} with no count — then
            confirm Received handoff before Close day. They&apos;ll need to sign in again to
            start a new one.
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
