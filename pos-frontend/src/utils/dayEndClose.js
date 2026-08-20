import { CASH_MOVEMENT_COUNTING_STATUSES } from '../lib/api'
import { grossFromNetAndDiscounts, rowBusinessDate } from './format'

/** A petty-cash row's kind, derived from legacy reason-prefix tagging when `kind` is absent. */
export function rowKind(row) {
  return (
    row.kind ||
    (String(row.reason || '').startsWith('[CHANGE FUND]')
      ? 'change_fund'
      : String(row.reason || '').startsWith('[PICKUP]')
        ? 'pickup'
        : 'paid_out')
  )
}

export function rowStatus(row) {
  return row.status || (rowKind(row) === 'paid_out' ? 'fulfilled' : 'recorded')
}

/** Counts cash-movement rows recorded by the current user that still require review. */
export function countUnreviewedSelfRecorded(rows = []) {
  return rows.filter((r) => r.status === 'self_recorded').length
}

/**
 * A shift that carried its starting cash forward from another shift OPENED THE SAME
 * BUSINESS DAY is not new money — it is the same drawer contents someone recounted, and
 * those sales are already inside `cashSales` (day-wide, not shift-scoped). See DayEnd.jsx
 * git history for the full reasoning (reopen-carry double-count bug).
 */
export function isDuplicateCarry(row, drawerShiftIds) {
  return (
    row.carriedFromShiftId &&
    drawerShiftIds.has(row.carriedFromShiftId) &&
    Math.abs(Number(row.startingCash || 0) - Number(row.carriedAmount || 0)) <= 0.004
  )
}

/**
 * Core Day End cash figures — recorded/expected drawer, float, and the open-shift /
 * pending-handoff gates. Single source of truth shared by the on-site counting screen
 * (DayEnd.jsx SupervisorDayEnd) and a manager's remote close (BranchDashboard.jsx) — these
 * two screens must never compute the money differently.
 */
export function computeDayEndFigures({
  transactions = [],
  movements = [],
  shifts = [],
  petty = [],
  date,
  dayOpenHour,
}) {
  const inBusinessDay = (item) => rowBusinessDate(item, dayOpenHour) === date
  const recorded = transactions
    .filter((item) => item.status === 'Paid' && inBusinessDay(item))
    .reduce((sum, item) => sum + Number(item.netTotal ?? item.total), 0)
  const cashTransactions = transactions.filter(
    (item) =>
      item.status === 'Paid' && inBusinessDay(item) && (item.paymentMethod || 'cash') === 'cash',
  )
  const cashSales = cashTransactions.reduce((sum, item) => sum + Number(item.netTotal ?? item.total), 0)
  const cardSales = transactions
    .filter((item) => item.status === 'Paid' && inBusinessDay(item) && item.paymentMethod === 'card')
    .reduce((sum, item) => sum + Number(item.netTotal ?? item.total), 0)
  const ewalletSales = transactions
    .filter((item) => item.status === 'Paid' && inBusinessDay(item) && item.paymentMethod === 'ewallet')
    .reduce((sum, item) => sum + Number(item.netTotal ?? item.total), 0)
  const cashDiscounts = cashTransactions.reduce((sum, item) => sum + Number(item.discountAmount || 0), 0)
  const cashSalesGross = grossFromNetAndDiscounts(cashSales, cashDiscounts)

  const changeFundRows = petty.filter((row) => rowKind(row) === 'change_fund')
  const pickupRows = petty.filter((row) => rowKind(row) === 'pickup')
  const paidOutRows = petty.filter((row) => rowKind(row) === 'paid_out')

  const drawerShifts = shifts.filter((row) => row.holdsDrawer !== false)
  const openDrawerShifts = drawerShifts.filter((row) => row.open)
  const pendingHandoffs = drawerShifts.filter((row) => !row.open && row.endingCash == null)
  const drawerShiftIds = new Set(drawerShifts.map((row) => row.id).filter(Boolean))
  const shiftFloatTotal = drawerShifts
    .filter((row) => !isDuplicateCarry(row, drawerShiftIds))
    .reduce((sum, row) => sum + Number(row.startingCash || 0), 0)
  const legacyFloatTotal = changeFundRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const changeFundTotal = shiftFloatTotal + legacyFloatTotal
  const pickupTotal = pickupRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)

  const countingMoves = movements.filter((m) => CASH_MOVEMENT_COUNTING_STATUSES.includes(m.status))
  const movePaidOutTotal = countingMoves
    .filter((m) => m.type === 'petty_cash')
    .reduce((sum, m) => sum + Number(m.amount || 0), 0)
  const movePickupTotal = countingMoves
    .filter((m) => m.type === 'pickup')
    .reduce((sum, m) => sum + Number(m.amount || 0), 0)
  const moveCashInTotal = countingMoves
    .filter((m) => m.type === 'cash_in')
    .reduce((sum, m) => sum + Number(m.amount || 0), 0)

  // Only cash that has actually been handed over leaves the drawer. An approved request
  // still sitting in the till is a commitment, not a disbursement.
  const paidOutTotal = paidOutRows
    .filter((row) => rowStatus(row) === 'fulfilled')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const approvedUnfulfilled = paidOutRows
    .filter((row) => rowStatus(row) === 'approved')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)

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

  const pettyCashHandedOver = Number((paidOutTotal + movePaidOutTotal).toFixed(2))

  return {
    recorded,
    cashSales,
    cardSales,
    ewalletSales,
    cashDiscounts,
    cashSalesGross,
    pickupRows,
    openDrawerShifts,
    pendingHandoffs,
    changeFundTotal,
    moveCashInTotal,
    pickupTotal,
    paidOutTotal,
    movePaidOutTotal,
    movePickupTotal,
    approvedUnfulfilled,
    expectedCash,
    pettyCashHandedOver,
  }
}
