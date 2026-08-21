import { supabase } from '../supabase'
import { localDateKey, rowBusinessDate } from '../../utils/format'
import { hasSupabase, fetchAllRows, fetchStaffIdentities } from './shared.js'
import { fetchStaffShifts } from './shifts.js'

/** Cash drawer ledger (change fund · pickups · petty paid-outs). */
export const CASH_DRAWER_TABLE = 'cash_drawer_entries'
export const CASH_DRAWER_COLS =
  'id, branch_id, staff_id, amount, reason, business_date, created_at, kind, status, receipt_ref, shift_id, requested_by, approved_by, approved_at, confirmed_by, confirmed_at, reject_reason'

/** cash_drawer_entries only — petty_cash dual-read removed (migrate_schema_cleanup_v1.sql). */
export async function withCashDrawerTable(run) {
  return run(CASH_DRAWER_TABLE)
}

export async function addPettyCash({
  branchId,
  staffId,
  amount,
  reason,
  businessDate,
  kind = 'paid_out',
  status = 'approved',
  receiptRef = null,
  shiftId = null,
  requestedBy = null,
  approvedBy = null,
  confirmedBy = null,
}) {
  const resolvedKind =
    kind ||
    (/^\[CHANGE FUND\]/i.test(reason || '')
      ? 'change_fund'
      : /^\[PICKUP\]/i.test(reason || '')
        ? 'pickup'
        : 'paid_out')
  const payload = {
    branch_id: branchId,
    staff_id: staffId,
    amount: Number(amount),
    reason: reason || '',
    business_date: businessDate,
    kind: resolvedKind,
    status,
    receipt_ref: receiptRef || null,
    shift_id: shiftId || null,
    requested_by: requestedBy || staffId || null,
    approved_by: approvedBy || (status === 'approved' || status === 'recorded' ? staffId : null),
    approved_at:
      status === 'approved' || status === 'recorded' ? new Date().toISOString() : null,
    confirmed_by: confirmedBy || null,
    confirmed_at: confirmedBy ? new Date().toISOString() : null,
  }
  let { data, error } = await withCashDrawerTable((table) =>
    supabase.from(table).insert(payload).select('*').single(),
  )
  if (error && /kind|status|receipt_ref|shift_id|schema cache|column/i.test(String(error.message || ''))) {
    // Older schema without workflow columns
    ;({ data, error } = await withCashDrawerTable((table) =>
      supabase
        .from(table)
        .insert({
          branch_id: branchId,
          staff_id: staffId,
          amount: Number(amount),
          reason: reason || '',
          business_date: businessDate,
        })
        .select('*')
        .single(),
    ))
  }
  if (error) throw error
  return mapPettyCashRow(data)
}

export function mapPettyCashRow(row) {
  if (!row) return null
  const reason = String(row.reason || '')
  const kind =
    row.kind ||
    (/^\[CHANGE FUND\]/i.test(reason)
      ? 'change_fund'
      : /^\[PICKUP\]/i.test(reason)
        ? 'pickup'
        : 'paid_out')
  // A paid-out with no status predates the workflow columns, so the cash was already handed
  // over — 'fulfilled', matching rowStatus() in DayEnd.jsx. Defaulting to 'approved' would
  // park a years-old disbursement in the "awaiting hand-over" queue and add its cash back
  // into the expected drawer.
  const status =
    row.status ||
    (kind === 'paid_out' ? 'fulfilled' : 'recorded')
  return {
    id: row.id,
    branchId: row.branch_id,
    staffId: row.staff_id,
    amount: Number(row.amount || 0),
    reason,
    kind,
    status,
    receiptRef: row.receipt_ref || '',
    shiftId: row.shift_id || null,
    requestedBy: row.requested_by || row.staff_id || null,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    confirmedBy: row.confirmed_by || null,
    confirmedAt: row.confirmed_at || null,
    rejectReason: row.reject_reason || '',
    businessDate: row.business_date,
    createdAt: row.created_at,
  }
}

/** Opening float at clock-in — cashier enters amount (no separate supervisor PIN step). */
export async function recordChangeFund({
  branchId,
  staffId,
  shiftId,
  amount,
  note,
  confirmedBy,
  businessDate,
}) {
  return addPettyCash({
    branchId,
    staffId,
    amount,
    reason: `[CHANGE FUND] ${note || 'Opening float'}`.trim(),
    businessDate,
    kind: 'change_fund',
    status: 'recorded',
    shiftId,
    requestedBy: staffId,
    confirmedBy,
  })
}

/** Statuses that reduce expected drawer cash (see migrate_cash_movements.sql). */
export const CASH_MOVEMENT_COUNTING_STATUSES = [
  'approved',
  'remote_approved',
  'self_recorded',
  'confirmed',
  'flagged_for_investigation',
]

function mapCashMovementRow(row) {
  if (!row) return null
  return {
    id: row.id,
    clientId: row.client_id || null,
    shiftId: row.shift_id,
    branchId: row.branch_id,
    drawerId: row.drawer_id || 'main',
    drawerLabel: row.drawer_label || 'Main drawer',
    type: row.type,
    amount: Number(row.amount || 0),
    reason: row.reason || '',
    requestedBy: row.requested_by,
    requestedAt: row.requested_at || row.created_at || null,
    status: row.status,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    deniedBy: row.denied_by || null,
    deniedAt: row.denied_at || null,
    selfRecordAck: Boolean(row.self_record_ack),
    selfRecordedAt: row.self_recorded_at || null,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    reviewAction: row.review_action || null,
    reviewNotes: row.review_notes || null,
    createdOffline: Boolean(row.created_offline),
    syncedAt: row.synced_at || null,
    createdAt: row.created_at || null,
  }
}

async function withCashMovementActors(rows) {
  if (!rows.length) return rows
  const who = await fetchStaffIdentities([
    ...rows.map((r) => r.requestedBy),
    ...rows.map((r) => r.approvedBy),
    ...rows.map((r) => r.deniedBy),
    ...rows.map((r) => r.reviewedBy),
  ]).catch(() => ({}))
  return rows.map((row) => ({
    ...row,
    requestedByName: row.requestedBy ? who[row.requestedBy]?.name || null : null,
    approvedByName: row.approvedBy ? who[row.approvedBy]?.name || null : null,
    deniedByName: row.deniedBy ? who[row.deniedBy]?.name || null : null,
    reviewedByName: row.reviewedBy ? who[row.reviewedBy]?.name || null : null,
  }))
}

export async function createCashMovementApproved({
  shiftId,
  branchId,
  drawerId,
  drawerLabel,
  type,
  amount,
  reason,
  requestedBy,
  approvedBy,
  clientId = null,
  createdOffline = false,
}) {
  const { data, error } = await supabase.rpc('create_cash_movement_approved', {
    p_shift_id: shiftId,
    p_branch_id: branchId,
    p_drawer_id: drawerId || 'main',
    p_drawer_label: drawerLabel || 'Main drawer',
    p_type: type,
    p_amount: Number(amount),
    p_reason: reason,
    p_requested_by: requestedBy,
    p_approved_by: approvedBy,
    p_client_id: clientId,
    p_created_offline: createdOffline,
  })
  if (error) throw error
  return mapCashMovementRow(data)
}

export async function createCashMovementPending({
  shiftId,
  branchId,
  drawerId,
  drawerLabel,
  type,
  amount,
  reason,
  requestedBy,
  clientId = null,
  createdOffline = false,
}) {
  const { data, error } = await supabase.rpc('create_cash_movement_pending', {
    p_shift_id: shiftId,
    p_branch_id: branchId,
    p_drawer_id: drawerId || 'main',
    p_drawer_label: drawerLabel || 'Main drawer',
    p_type: type,
    p_amount: Number(amount),
    p_reason: reason,
    p_requested_by: requestedBy,
    p_client_id: clientId,
    p_created_offline: createdOffline,
  })
  if (error) throw error
  return mapCashMovementRow(data)
}

export async function approveCashMovementPin({ id, approvedBy }) {
  const { data, error } = await supabase.rpc('approve_cash_movement_pin', {
    p_id: id,
    p_approved_by: approvedBy,
  })
  if (error) throw error
  return mapCashMovementRow(data)
}

export async function approveCashMovementManager({ id, approvedBy }) {
  const { data, error } = await supabase.rpc('approve_cash_movement_manager', {
    p_id: id,
    p_approved_by: approvedBy,
  })
  if (error) throw error
  return mapCashMovementRow(data)
}

export async function denyCashMovement({ id, deniedBy }) {
  const { data, error } = await supabase.rpc('deny_cash_movement', {
    p_id: id,
    p_denied_by: deniedBy,
  })
  if (error) throw error
  return mapCashMovementRow(data)
}

/** Cashier (or manager) abandons a pending_remote Open Drawer request. */
export async function cancelCashMovement({ id, cancelledBy }) {
  const { data, error } = await supabase.rpc('cancel_cash_movement', {
    p_id: id,
    p_cancelled_by: cancelledBy,
  })
  if (error) throw error
  return mapCashMovementRow(data)
}

export async function selfRecordCashMovement({ id, staffId, ack = true }) {
  const { data, error } = await supabase.rpc('self_record_cash_movement', {
    p_id: id,
    p_staff_id: staffId,
    p_ack: Boolean(ack),
  })
  if (error) throw error
  return mapCashMovementRow(data)
}

export async function reviewCashMovement({ id, reviewedBy, action, notes = null }) {
  const { data, error } = await supabase.rpc('review_cash_movement', {
    p_id: id,
    p_reviewed_by: reviewedBy,
    p_action: action,
    p_notes: notes,
  })
  if (error) throw error
  return mapCashMovementRow(data)
}

/** Manager-only: flagged_for_investigation → confirmed (Resolved). */
export async function resolveFlaggedCashMovement({ id, resolvedBy, notes = null }) {
  const { data, error } = await supabase.rpc('resolve_flagged_cash_movement', {
    p_id: id,
    p_resolved_by: resolvedBy,
    p_notes: notes,
  })
  if (error) throw error
  return mapCashMovementRow(data)
}

export async function fetchCashMovementById(id) {
  if (!hasSupabase || !id) return null
  const { data, error } = await supabase.from('cash_movements').select('*').eq('id', id).maybeSingle()
  if (error) {
    if (/cash_movements|schema cache|does not exist/i.test(String(error.message || ''))) return null
    throw error
  }
  const mapped = mapCashMovementRow(data)
  if (!mapped) return null
  const [withNames] = await withCashMovementActors([mapped])
  return withNames
}

/**
 * List cash movements. `start`/`end` are BUSINESS dates (same convention as everywhere
 * else — see rowBusinessDate) — the SQL range is deliberately buffered a calendar day on
 * each side and then narrowed precisely below via rowBusinessDate, because `requested_at`
 * is a plain instant with no idea where the branch's open hour falls: a movement rung
 * between midnight and openHour carries the NEXT calendar date in local wall-clock terms
 * while still belonging to the CURRENT business day (identical trap to item.date on
 * transactions — see utils/format.js's rowBusinessDate doc comment). A tight same-day
 * clamp silently hid exactly those rows — e.g. a petty-cash entry rung at 12:18 AM PH time
 * never matched a `{start: end: "yesterday's business date"}` query for the shift that
 * was still, business-wise, on that day.
 */
export async function fetchCashMovements({
  branchId = null,
  shiftIds = null,
  start = null,
  end = null,
  type = null,
  status = null,
  requestedBy = null,
  drawerId = null,
  dayOpenHour = undefined,
} = {}) {
  if (!hasSupabase) return []
  const shiftDateKey = (key, days) => {
    const d = new Date(`${key}T00:00:00`)
    d.setDate(d.getDate() + days)
    return localDateKey(d)
  }
  try {
    const { data, error } = await fetchAllRows((from, to) => {
      let q = supabase
        .from('cash_movements')
        .select('*')
        .order('requested_at', { ascending: false })
        .range(from, to)
      if (branchId) q = q.eq('branch_id', branchId)
      if (Array.isArray(shiftIds) && shiftIds.length) q = q.in('shift_id', shiftIds)
      if (requestedBy) q = q.eq('requested_by', requestedBy)
      // +08:00 matches PH local wall clock. Buffered a day on each side of the requested
      // business-date range — see doc comment above — then narrowed exactly below.
      if (start) q = q.gte('requested_at', `${shiftDateKey(start, -1)}T00:00:00+08:00`)
      if (end) q = q.lte('requested_at', `${shiftDateKey(end, 1)}T23:59:59.999+08:00`)
      if (type) q = q.eq('type', type)
      if (status) q = q.eq('status', status)
      if (drawerId) q = q.eq('drawer_id', drawerId)
      return q
    })
    if (error) {
      if (/cash_movements|schema cache|does not exist/i.test(String(error.message || ''))) return []
      throw error
    }
    let rows = await withCashMovementActors((data || []).map(mapCashMovementRow).filter(Boolean))
    if (start || end) {
      rows = rows.filter((row) => {
        const biz = rowBusinessDate({ createdAt: row.requestedAt || row.createdAt }, dayOpenHour)
        if (start && biz < start) return false
        if (end && biz > end) return false
        return true
      })
    }
    return rows
  } catch (err) {
    if (/cash_movements|schema cache|does not exist/i.test(String(err?.message || ''))) return []
    throw err
  }
}

export async function fetchPendingCashMovements({ branchId = null, manager = false } = {}) {
  if (!hasSupabase) return []
  try {
    let q = supabase
      .from('cash_movements')
      .select('*')
      .eq('status', 'pending_remote')
      .order('requested_at', { ascending: false })
      .limit(40)
    if (!manager && branchId) q = q.eq('branch_id', branchId)
    const { data, error } = await q
    if (error) {
      if (/cash_movements|schema cache|does not exist/i.test(String(error.message || ''))) return []
      throw error
    }
    return withCashMovementActors((data || []).map(mapCashMovementRow).filter(Boolean))
  } catch (err) {
    if (/cash_movements|schema cache|does not exist/i.test(String(err?.message || ''))) return []
    throw err
  }
}

/** Resolve requester / approver / fulfiller names (and the approver's role) onto rows. */
async function withPettyCashActors(rows) {
  if (!rows.length) return rows
  const who = await fetchStaffIdentities([
    ...rows.map((row) => row.staffId),
    ...rows.map((row) => row.requestedBy),
    ...rows.map((row) => row.approvedBy),
    ...rows.map((row) => row.confirmedBy),
  ]).catch(() => ({}))
  return rows.map((row) => ({
    ...row,
    staffName: who[row.staffId]?.name || null,
    requestedByName: row.requestedBy ? who[row.requestedBy]?.name || null : null,
    approvedByName: row.approvedBy ? who[row.approvedBy]?.name || null : null,
    approvedByRole: row.approvedBy ? who[row.approvedBy]?.role || null : null,
    confirmedByName: row.confirmedBy ? who[row.confirmedBy]?.name || null : null,
  }))
}

export async function fetchPettyCash(branchId, businessDate) {
  const { data, error } = await withCashDrawerTable((table) =>
    supabase
      .from(table)
      .select(CASH_DRAWER_COLS)
      .eq('branch_id', branchId)
      .eq('business_date', businessDate)
      .order('created_at', { ascending: false }),
  )
  if (error) {
    if (isMissingCashDrawerTable(error)) return []
    // Older schemas without kind/status columns
    if (/kind|status|receipt_ref|schema cache|column/i.test(String(error.message || ''))) {
      const fallback = await withCashDrawerTable((table) =>
        supabase
          .from(table)
          .select('id, branch_id, staff_id, amount, reason, business_date, created_at')
          .eq('branch_id', branchId)
          .eq('business_date', businessDate)
          .order('created_at', { ascending: false }),
      )
      if (fallback.error) {
        if (isMissingCashDrawerTable(fallback.error)) return []
        throw fallback.error
      }
      return (fallback.data || []).map(mapPettyCashRow)
    }
    throw error
  }
  // Names/roles for the three actors, so the day-end panel can say who asked, who
  // approved and who handed the cash over without a second round trip per row.
  return withPettyCashActors((data || []).map(mapPettyCashRow))
}

export async function fetchPettyCashTimeline(branchId, { startDate, endDate } = {}) {
  const runQuery = (cols) =>
    withCashDrawerTable((table) => {
      let query = supabase
        .from(table)
        .select(cols)
        .eq('branch_id', branchId)
        .order('created_at', { ascending: false })
      if (startDate) query = query.gte('business_date', startDate)
      if (endDate) query = query.lte('business_date', endDate)
      return query
    })

  let { data, error } = await runQuery(CASH_DRAWER_COLS)
  if (error && /kind|status|receipt_ref|schema cache|column/i.test(String(error.message || ''))) {
    ;({ data, error } = await runQuery('id, branch_id, staff_id, amount, reason, business_date, created_at'))
  }
  if (error) {
    if (isMissingCashDrawerTable(error)) return []
    throw error
  }

  const rows = (data || []).map(mapPettyCashRow)
  const who = await fetchStaffIdentities([
    ...rows.map((row) => row.staffId),
    ...rows.map((row) => row.requestedBy),
    ...rows.map((row) => row.approvedBy),
    ...rows.map((row) => row.confirmedBy),
  ])
  return rows.map((row) => ({
    ...row,
    staffName: who[row.staffId]?.name || 'Staff',
    requestedByName: row.requestedBy ? who[row.requestedBy]?.name || 'Staff' : null,
    approvedByName: row.approvedBy ? who[row.approvedBy]?.name || 'Staff' : null,
    approvedByRole: row.approvedBy ? who[row.approvedBy]?.role || null : null,
    confirmedByName: row.confirmedBy ? who[row.confirmedBy]?.name || 'Staff' : null,
    confirmedByRole: row.confirmedBy ? who[row.confirmedBy]?.role || null : null,
  }))
}

/**
 * Today's payment/cash-drawer impact for one branch — sales by tender (net of same-tender
 * refunds, same as `recorded`/`netTotal` on `SupervisorDayEnd`), cash actually handed back,
 * and the resulting expected-cash figure. `expectedCash` is the EXACT formula
 * `SupervisorDayEnd` (`DayEnd.jsx`) uses for its own "Expected" line, reused here rather than
 * re-derived, so a dashboard tile can never quietly disagree with the real Day End screen.
 *
 * `cardSales`/`ewalletSales` are informational only — deliberately excluded from
 * `expectedCash`, since a card/e-wallet payment never touches the physical drawer.
 *
 * Always scoped to one business day (`date`) — an expected-cash figure is a once-per-day
 * drawer count, not something that means anything summed over a week.
 */
export async function fetchBranchCashImpact(branchId, date, openHour = 7) {
  const empty = {
    cashSales: 0,
    cardSales: 0,
    ewalletSales: 0,
    cashRefunds: 0,
    changeFund: 0,
    pickup: 0,
    paidOut: 0,
    expectedCash: 0,
  }
  if (!branchId || !date || !supabase) return empty

  // A generous calendar-day buffer around the business date, narrowed precisely afterward
  // with rowBusinessDate — never compare a business date to a calendar date directly (see
  // the same rule in DayEnd.jsx / BranchDashboard.jsx).
  const windowStart = new Date(`${date}T00:00:00`)
  windowStart.setDate(windowStart.getDate() - 1)
  const windowEnd = new Date(`${date}T00:00:00`)
  windowEnd.setDate(windowEnd.getDate() + 2)

  const [txRes, pettyRows, shiftRows, moveRows] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from('transactions')
        .select('total_amount, refunded_amount, status, payment_method, created_at')
        .eq('branch_id', branchId)
        .gte('created_at', windowStart.toISOString())
        .lt('created_at', windowEnd.toISOString())
        .order('created_at', { ascending: true })
        .range(from, to),
    ),
    fetchPettyCashTimeline(branchId, { startDate: date, endDate: date }).catch(() => []),
    fetchStaffShifts({ branchId, start: date, end: date }).catch(() => []),
    fetchCashMovements({ branchId, start: date, end: date, dayOpenHour: openHour }).catch(() => []),
  ])
  if (txRes.error) throw txRes.error

  const todayRows = (txRes.data || [])
    .map((row) => ({
      total: Number(row.total_amount || 0),
      refundedAmount: Number(row.refunded_amount || 0),
      status: row.status === 'voided' ? 'Voided' : 'Paid',
      paymentMethod: ['card', 'ewallet'].includes(String(row.payment_method || '').toLowerCase())
        ? String(row.payment_method).toLowerCase()
        : 'cash',
      createdAt: row.created_at,
    }))
    .filter((row) => rowBusinessDate(row, openHour) === date)

  const cashToday = todayRows.filter((row) => row.paymentMethod === 'cash')
  // Net of refunds — a voided sale was never counted in here (filtered to status === 'Paid'),
  // so its total never inflates this figure; only a real refund on a completed sale does.
  const netByMethod = (method) =>
    todayRows
      .filter((row) => row.status === 'Paid' && row.paymentMethod === method)
      .reduce((sum, row) => sum + Math.max(0, row.total - row.refundedAmount), 0)
  const cashSales = netByMethod('cash')
  const cardSales = netByMethod('card')
  const ewalletSales = netByMethod('ewallet')
  // Cash actually handed back on a refund only — the figure the physical drawer count is
  // reconciled against. A card/e-wallet refund never leaves this drawer, so it is not
  // summed in here.
  const cashRefunds = cashToday.reduce((sum, row) => sum + row.refundedAmount, 0)

  const drawerShifts = (shiftRows || []).filter((row) => row.holdsDrawer !== false)
  // Exclude a shift's startingCash when it was carried forward from another shift that
  // opened on this SAME business date (fetchStaffShifts above is already date-scoped, so a
  // carry from an earlier date is simply absent from this set and still counts as real
  // float below) — that cash is not new money, it is the prior shift's drawer contents
  // re-counted, and its sales are already inside `cashSales` below. Only holds while
  // startingCash still equals the frozen carriedAmount (a pure recount); once it diverges —
  // the cashier adjusted the pre-filled count, or declared a fresh 'opening_float' movement
  // after opening at ₱0 — it is a genuinely different declared amount and must be counted,
  // same as any non-carried shift. Same reasoning as DayEnd.jsx's shiftFloatTotal — see the
  // comment there.
  const drawerShiftIds = new Set(drawerShifts.map((row) => row.id).filter(Boolean))
  const isDuplicateCarry = (row) =>
    row.carriedFromShiftId &&
    drawerShiftIds.has(row.carriedFromShiftId) &&
    Math.abs(Number(row.startingCash || 0) - Number(row.carriedAmount || 0)) <= 0.004
  const shiftFloatTotal = drawerShifts
    .filter((row) => !isDuplicateCarry(row))
    .reduce((sum, row) => sum + Number(row.startingCash || 0), 0)
  // The float moved from cash_drawer_entries (`change_fund` rows) to staff_shifts.starting_cash
  // mid-project — both sources are summed, same as DayEnd.jsx, so a pre-migration business
  // day still counts its float correctly.
  const legacyFloatTotal = (pettyRows || [])
    .filter((row) => row.kind === 'change_fund')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const changeFund = shiftFloatTotal + legacyFloatTotal
  const pickup = (pettyRows || [])
    .filter((row) => row.kind === 'pickup')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  // Only cash that has actually left the drawer — an approved-but-unfulfilled paid-out is
  // still sitting in the till (same rule DayEnd.jsx applies).
  const paidOut = (pettyRows || [])
    .filter((row) => row.kind === 'paid_out' && row.status === 'fulfilled')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)

  // POS → Open Drawer requests (cash_movements) are a separate ledger from the legacy
  // cash_drawer_entries petty-cash table above — same statuses DayEnd.jsx/BranchDashboard.jsx
  // treat as "left the drawer" (see CASH_MOVEMENT_COUNTING_STATUSES), summed in here too so
  // this figure doesn't undercount petty cash/pickups recorded through Open Drawer.
  const countingMoves = (moveRows || []).filter((m) => CASH_MOVEMENT_COUNTING_STATUSES.includes(m.status))
  const moveCashIn = countingMoves
    .filter((m) => m.type === 'cash_in')
    .reduce((sum, m) => sum + Number(m.amount || 0), 0)
  const movePickup = countingMoves
    .filter((m) => m.type === 'pickup')
    .reduce((sum, m) => sum + Number(m.amount || 0), 0)
  const movePaidOut = countingMoves
    .filter((m) => m.type === 'petty_cash')
    .reduce((sum, m) => sum + Number(m.amount || 0), 0)
  const totalChangeFund = changeFund + moveCashIn
  const totalPickup = pickup + movePickup
  const totalPaidOut = paidOut + movePaidOut

  return {
    cashSales: Number(cashSales.toFixed(2)),
    cardSales: Number(cardSales.toFixed(2)),
    ewalletSales: Number(ewalletSales.toFixed(2)),
    cashRefunds: Number(cashRefunds.toFixed(2)),
    changeFund: Number(totalChangeFund.toFixed(2)),
    pickup: Number(totalPickup.toFixed(2)),
    paidOut: Number(totalPaidOut.toFixed(2)),
    expectedCash: Number((totalChangeFund + cashSales - totalPaidOut - totalPickup).toFixed(2)),
  }
}
