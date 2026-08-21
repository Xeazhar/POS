import { supabase } from '../supabase'
import { appError } from '../../utils/errors'
import { isMissingColumnError, localDayBoundsIso, fetchStaffIdentities } from './shared.js'
import { recordChangeFund } from './cash.js'

export function mapShiftRow(row) {
  if (!row) return null
  return {
    id: row.id,
    serverId: row.id,
    clientId: row.client_id || null,
    branchId: row.branch_id,
    branchName: row.branches?.name || '',
    staffId: row.staff_id,
    staffName: row.staff?.full_name || '',
    staffRole: row.staff?.role || '',
    drawerId: row.drawer_id || 'main',
    drawerLabel: row.drawer_label || '',
    holdsDrawer: row.holds_drawer !== false,
    businessDate: row.business_date || null,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    shiftPeriod: row.shift_period === 'am' || row.shift_period === 'pm' ? row.shift_period : null,
    startingCash: row.starting_cash == null ? null : Number(row.starting_cash),
    carriedFromShiftId: row.carried_from_shift_id || null,
    carriedAmount: row.carried_amount == null ? null : Number(row.carried_amount),
    endingCash: row.ending_cash == null ? null : Number(row.ending_cash),
    expectedCash: row.expected_cash == null ? null : Number(row.expected_cash),
    variance: row.variance == null ? null : Number(row.variance),
    cashSales: Number(row.cash_sales || 0),
    cashRefunds: Number(row.cash_refunds || 0),
    cashPaidOut: Number(row.cash_paid_out || 0),
    cashPickups: Number(row.cash_pickups || 0),
    closeNote: row.close_note || '',
    closedBy: row.closed_by || null,
    open: !row.clock_out,
    status: row.clock_out ? 'closed' : 'open',
  }
}

const SHIFT_COLS =
  'id, branch_id, staff_id, drawer_id, drawer_label, holds_drawer, business_date, clock_in, clock_out, shift_period, starting_cash, carried_from_shift_id, carried_amount, ending_cash, expected_cash, variance, cash_sales, cash_refunds, cash_paid_out, cash_pickups, close_note, closed_by, client_id'
// shift_period is optional on older schemas — keep cash columns if it's missing.
const SHIFT_COLS_CORE = SHIFT_COLS.replace(', shift_period', '')
const SHIFT_COLS_LEGACY = 'id, branch_id, staff_id, clock_in, clock_out, shift_period'
const SHIFT_COLS_MINIMAL = 'id, branch_id, staff_id, clock_in, clock_out'

/** One of the optional staff_shifts columns is absent — a migration hasn't been applied yet. */
function isMissingOptionalShiftColumn(error) {
  return /shift_period/i.test(String(error?.message || error || ''))
}

/** True when the database predates migrate_shift_cash_accountability.sql. */
function isMissingShiftCashSchema(error) {
  return /drawer_id|starting_cash|business_date|open_staff_shift|close_staff_shift|shift_cash_summary|adjust_shift_cash|schema cache|does not exist|Could not find/i.test(
    String(error?.message || error || ''),
  )
}

/** The RPC itself is absent — i.e. migrate_shift_cash_accountability.sql is not applied. */
function isMissingShiftRpc(error, name) {
  const raw = String(error?.message || error || '')
  return new RegExp(`Could not find the function.*${name}|function public\\.${name}.*does not exist`, 'i').test(raw)
}

/** Turn a Postgres exception raised by the shift RPCs into a support-coded error. */
function shiftRpcError(error) {
  const raw = String(error?.message || error || '')
  if (/SHIFT_DRAWER_BUSY/.test(raw)) return appError('SHIFT02', raw)
  if (/SHIFT_CLOSED/.test(raw)) return appError('SHIFT04', raw)
  if (/SHIFT_NOT_ALLOWED/.test(raw)) return appError('SHIFT05', raw)
  if (/SHIFT_FLOAT_REQUIRED|SHIFT_COUNT_REQUIRED|SHIFT_REASON_REQUIRED|SHIFT_BAD_AMOUNT|SHIFT_BAD_FIELD/.test(raw)) {
    return appError('SHIFT03', raw)
  }
  return error
}

/**
 * Start a shift and record its change fund in one server call.
 *
 * Idempotent on `clientId`, and it resumes rather than duplicates when the same cashier
 * is already open on the drawer — both matter because this call is replayed from the
 * offline outbox, where "ran twice" is normal, not exceptional.
 */
export async function openShift({
  branchId,
  staffId,
  drawerId,
  drawerLabel = null,
  startingCash,
  shiftPeriod = null,
  clientId = null,
  carriedFromShiftId = null,
  carriedAmount = null,
  businessDate = null,
  holdsDrawer = true,
}) {
  const { data, error } = await supabase.rpc('open_staff_shift', {
    p_branch_id: branchId,
    p_staff_id: staffId,
    p_drawer_id: drawerId || 'main',
    p_starting_cash: holdsDrawer ? Number(startingCash || 0) : null,
    p_shift_period: shiftPeriod === 'am' || shiftPeriod === 'pm' ? shiftPeriod : null,
    p_client_id: clientId,
    p_carried_from: carriedFromShiftId,
    p_carried_amount: carriedAmount == null ? null : Number(carriedAmount),
    p_business_date: businessDate,
    p_drawer_label: drawerLabel,
    p_holds_drawer: holdsDrawer !== false,
  })
  if (error) {
    // Database without migrate_shift_cash_accountability.sql. Fall back to the old
    // clock-in + change-fund-entry pair rather than refusing to open a shift, which would
    // stop the branch selling entirely until someone runs a migration.
    if (isMissingShiftRpc(error, 'open_staff_shift')) {
      const legacy = await clockIn({ branchId, staffId, shiftPeriod, businessDate })
      if (holdsDrawer !== false && Number(startingCash || 0) > 0 && legacy?.id) {
        await recordChangeFund({
          branchId,
          staffId,
          shiftId: legacy.id,
          amount: Number(startingCash),
          note: 'Opening float',
          confirmedBy: staffId,
          businessDate,
        }).catch(() => {})
      }
      return mapShiftRow({
        ...legacy,
        drawer_id: drawerId || 'main',
        drawer_label: drawerLabel,
        holds_drawer: holdsDrawer !== false,
        starting_cash: holdsDrawer !== false ? Number(startingCash || 0) : null,
        business_date: businessDate,
        client_id: clientId,
      })
    }
    throw shiftRpcError(error)
  }
  return mapShiftRow(Array.isArray(data) ? data[0] : data)
}

/**
 * End a shift. `endingCash` is optional now — ending a shift no longer counts the drawer
 * (Day End does that once per business day); when omitted the shift closes with no
 * ending/expected/variance figures rather than a fabricated ₱0.00 count. When a count IS
 * given, expected cash and variance are still computed server-side from rows attributed to
 * the shift — never sent from here.
 */
export async function closeShift({ shiftId, endingCash = null, note = '', closedBy = null }) {
  const { data, error } = await supabase.rpc('close_staff_shift', {
    p_shift_id: shiftId,
    p_ending_cash: endingCash == null ? null : Number(endingCash),
    p_note: note || null,
    p_closed_by: closedBy,
  })
  if (error) {
    // Pre-migration: end the shift the old way. No expected/variance is computed, because
    // nothing attributed sales to the shift — a fabricated variance would be worse. The
    // counted cash itself is still written; see clockOut.
    if (isMissingShiftRpc(error, 'close_staff_shift')) {
      return mapShiftRow(await clockOut(shiftId, { endingCash, note, closedBy }))
    }
    throw shiftRpcError(error)
  }
  return mapShiftRow(Array.isArray(data) ? data[0] : data)
}

/** Live cash position of an open shift — what the cash-out screen counts against. */
export async function fetchShiftCashSummary(shiftId) {
  const { data, error } = await supabase.rpc('shift_cash_summary', { p_shift_id: shiftId })
  if (error) {
    if (isMissingShiftCashSchema(error)) return null
    throw error
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  return {
    startingCash: Number(row.starting_cash || 0),
    cashSales: Number(row.cash_sales || 0),
    cashRefunds: Number(row.cash_refunds || 0),
    cashPaidOut: Number(row.cash_paid_out || 0),
    cashPickups: Number(row.cash_pickups || 0),
    cashIn: Number(row.cash_in || 0),
    expectedCash: Number(row.expected_cash || 0),
    saleCount: Number(row.sale_count || 0),
  }
}

/**
 * Whoever currently holds this drawer, if anyone.
 *
 * Goes through drawer_holder() rather than reading staff_shifts, because RLS deliberately
 * hides other cashiers' shifts from a cashier — and this is the one thing about them a
 * cashier legitimately needs before counting cash into the same till. The function returns
 * a name and a start time only, no cash figures.
 */
export async function fetchOpenShiftOnDrawer({ branchId, drawerId }) {
  const { data, error } = await supabase.rpc('drawer_holder', {
    p_branch_id: branchId,
    p_drawer_id: drawerId || 'main',
  })
  if (error) {
    if (isMissingShiftCashSchema(error)) return null
    throw error
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  return {
    id: row.shift_id,
    serverId: row.shift_id,
    branchId,
    drawerId: drawerId || 'main',
    staffId: row.staff_id,
    staffName: row.staff_name || 'Another cashier',
    clockIn: row.clock_in,
    isMine: row.is_mine === true,
    holdsDrawer: true,
    open: true,
    status: 'open',
    // Deliberately absent: this view carries no cash figures.
    startingCash: null,
  }
}

/** Every open shift at a branch — the supervisor's "who is on the tills" view. */
export async function fetchOpenShiftsForBranch(branchId) {
  const run = (cols) =>
    supabase
      .from('staff_shifts')
      .select(`${cols}, staff:staff_id(id, full_name, role)`)
      .eq('branch_id', branchId)
      .is('clock_out', null)
      .order('clock_in', { ascending: false })

  let { data, error } = await run(SHIFT_COLS)
  if (error && isMissingOptionalShiftColumn(error)) {
    ;({ data, error } = await run(SHIFT_COLS_CORE))
  }
  if (error) {
    if (isMissingShiftCashSchema(error)) return []
    throw error
  }
  return (data || []).map(mapShiftRow)
}

/** Last shift to cash out on this drawer — its ending count pre-fills a handoff. */
export async function fetchLastClosedShiftOnDrawer({ branchId, drawerId }) {
  const { data, error } = await supabase.rpc('drawer_last_count', {
    p_branch_id: branchId,
    p_drawer_id: drawerId || 'main',
  })
  if (error) {
    if (isMissingShiftCashSchema(error)) return null
    throw error
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  return {
    id: row.shift_id,
    serverId: row.shift_id,
    branchId,
    drawerId: drawerId || 'main',
    staffName: row.staff_name || '',
    clockOut: row.clock_out,
    endingCash: row.ending_cash == null ? null : Number(row.ending_cash),
    holdsDrawer: true,
    open: false,
    status: 'closed',
  }
}

/** Supervisor/manager correction to a closed shift's count. Always logged, never silent. */
export async function adjustShiftCash({ shiftId, field, newValue, reason, approvedBy = null }) {
  const { data, error } = await supabase.rpc('adjust_shift_cash', {
    p_shift_id: shiftId,
    p_field: field,
    p_new_value: Number(newValue),
    p_reason: reason,
    p_approved_by: approvedBy,
  })
  if (error) throw shiftRpcError(error)
  return mapShiftRow(Array.isArray(data) ? data[0] : data)
}

/**
 * Supervisor confirms cashier drawer handoff after the shift closed with no ending count.
 * Fills ending/expected from shift components; clears Staff "Pending handoff".
 * Needs migrate_receive_shift_handoff.sql.
 */
export async function receiveShiftHandoff({ shiftId, receivedBy = null }) {
  const { data, error } = await supabase.rpc('receive_shift_handoff', {
    p_shift_id: shiftId,
    p_received_by: receivedBy,
  })
  if (error) {
    if (isMissingShiftRpc(error, 'receive_shift_handoff')) {
      throw appError(
        'SHIFT05',
        'receive_shift_handoff is missing — apply migrate_receive_shift_handoff.sql',
      )
    }
    throw shiftRpcError(error)
  }
  return mapShiftRow(Array.isArray(data) ? data[0] : data)
}

export async function fetchShiftAdjustments(shiftIds = []) {
  const ids = (shiftIds || []).filter(Boolean)
  if (!ids.length) return []
  const { data, error } = await supabase
    .from('shift_adjustments')
    .select('id, shift_id, field, old_value, new_value, reason, adjusted_by, approved_by, created_at, staff:adjusted_by(full_name, role)')
    .in('shift_id', ids)
    .order('created_at', { ascending: false })
  if (error) {
    if (isMissingShiftCashSchema(error)) return []
    throw error
  }
  return (data || []).map((row) => ({
    id: row.id,
    shiftId: row.shift_id,
    field: row.field,
    oldValue: row.old_value == null ? null : Number(row.old_value),
    newValue: Number(row.new_value || 0),
    reason: row.reason || '',
    adjustedBy: row.adjusted_by || null,
    adjustedByName: row.staff?.full_name || '',
    adjustedByRole: row.staff?.role || '',
    approvedBy: row.approved_by || null,
    createdAt: row.created_at,
  }))
}

export async function clockIn({ branchId, staffId, shiftPeriod = null, businessDate = null }) {
  const period = shiftPeriod === 'am' || shiftPeriod === 'pm' ? shiftPeriod : null
  const payload = {
    branch_id: branchId,
    staff_id: staffId,
    clock_in: new Date().toISOString(),
  }
  if (period) payload.shift_period = period
  // Stamp the business date the till computed. Without it the row is invisible to every
  // business-date range query (see fetchStaffShifts), so a shift opened through this
  // legacy path would never appear in Day end's "Change fund by shift".
  if (businessDate) payload.business_date = businessDate
  const { data, error } = await supabase.from('staff_shifts').insert(payload).select('*').single()
  if (error) {
    // Older DBs without shift_period / business_date — retry with the minimum column set
    if (
      (period || businessDate) &&
      (isMissingColumnError(error, 'shift_period') ||
        isMissingColumnError(error, 'business_date') ||
        /shift_period|business_date/i.test(String(error.message || '')))
    ) {
      const fallback = await supabase
        .from('staff_shifts')
        .insert({
          branch_id: branchId,
          staff_id: staffId,
          clock_in: new Date().toISOString(),
        })
        .select('*')
        .single()
      if (fallback.error) throw fallback.error
      return fallback.data
    }
    throw error
  }
  return data
}

/**
 * End a shift by writing clock_out directly — the pre-RPC path.
 *
 * The counted drawer has to be written here too. Clocking out and dropping `ending_cash`
 * closes the shift with no count on it, which every reader then shows as "Pending handoff"
 * forever: a closed shift cannot be edited afterwards, so the cashier's figure is gone for
 * good. Expected/variance are still left null — nothing attributed sales to the shift on
 * this schema, and a fabricated variance would be worse than an absent one.
 */
export async function clockOut(shiftId, { endingCash = null, note = '', closedBy = null } = {}) {
  const clockOutAt = new Date().toISOString()
  const patch = { clock_out: clockOutAt }
  if (endingCash != null) patch.ending_cash = Number(endingCash)
  if (note) patch.close_note = note
  if (closedBy) patch.closed_by = closedBy

  const run = (values) =>
    supabase.from('staff_shifts').update(values).eq('id', shiftId).select('*').single()

  let { data, error } = await run(patch)
  // Truly old schema: staff_shifts is just a clock-in/clock-out log with nowhere to put a
  // count. Ending the shift still has to work — the drawer figure is recorded on paper.
  if (
    error &&
    (isMissingColumnError(error, 'ending_cash') ||
      isMissingColumnError(error, 'close_note') ||
      isMissingColumnError(error, 'closed_by'))
  ) {
    ;({ data, error } = await run({ clock_out: clockOutAt }))
  }
  if (error) throw error
  return data
}

/**
 * The staff member's own open shift, if any.
 *
 * `drawerId` narrows it to one physical till: same cashier on a DIFFERENT terminal is not
 * the same cash context, so that must not resume — see Shell's shift gate.
 */
export async function fetchOpenShift(staffId, { drawerId = null } = {}) {
  const run = async (cols) => {
    let query = supabase
      .from('staff_shifts')
      .select(cols)
      .eq('staff_id', staffId)
      .is('clock_out', null)
    // Only narrow by drawer on column sets that actually have the column — the older tiers
    // predate per-drawer shifts, and filtering on it there fails the query outright.
    if (drawerId && cols.includes('drawer_id')) query = query.eq('drawer_id', drawerId)
    return query.order('clock_in', { ascending: false }).limit(1).maybeSingle()
  }

  // shift_period first: it is only a label, and treating its absence as a missing cash schema
  // would resume the shift with no starting_cash — the cashier's change fund would read as
  // never counted. See SHIFT_COLS_CORE.
  let { data, error } = await run(SHIFT_COLS)
  if (error && isMissingOptionalShiftColumn(error)) {
    ;({ data, error } = await run(SHIFT_COLS_CORE))
  }
  if (error && isMissingShiftCashSchema(error)) {
    ;({ data, error } = await run(SHIFT_COLS_LEGACY))
  }
  if (error) {
    if (isMissingOptionalShiftColumn(error) || /schema cache|column/i.test(String(error.message || ''))) {
      const fallback = await run(SHIFT_COLS_MINIMAL)
      if (fallback.error) {
        if (isMissingColumnError(fallback.error, 'staff_shifts') || /staff_shifts|schema cache/i.test(String(fallback.error.message || ''))) {
          return null
        }
        throw fallback.error
      }
      return mapShiftRow(fallback.data)
    }
    if (isMissingColumnError(error, 'staff_shifts') || /staff_shifts|schema cache/i.test(String(error.message || ''))) {
      return null
    }
    throw error
  }
  return mapShiftRow(data)
}

/**
 * Shift log for supervisors (one branch) or managers (all / filtered).
 *
 * Ranges match on `business_date`, not on `clock_in`. Filtering by the clock-in instant
 * dropped shifts out of Day end's "Change fund by shift" for two independent reasons:
 *
 *  - A business day runs from the branch's open hour to the next open hour, so a shift
 *    started at 05:00 belongs to the PREVIOUS business date. Bucketing it by the calendar
 *    day of its clock-in files it under a day the supervisor is not looking at.
 *  - `clock_in` is timestamptz and a bare `2026-08-09T00:00:00` is read in the database
 *    session's zone — UTC on Supabase, not Manila. That shifted the whole window eight
 *    hours, so the opening hours of every trading day fell outside it.
 *
 * Together those made a drawer's own float and closing count look unrecorded. `business_date`
 * is a plain date written from the same value the till computed, so neither applies. Rows
 * predating that column fall back to clock_in rather than disappearing.
 */
export async function fetchStaffShifts({ branchId = null, start = null, end = null, limit = 300 } = {}) {
  const JOINS = 'staff:staff_id(id, full_name, role), branches:branch_id(id, name)'
  const { startIso: shiftStartIso, endIso: shiftEndIso } = localDayBoundsIso(start, end)
  // Millisecond suffix stripped — this value gets embedded inline in a PostgREST `.or()`
  // filter string below, and the plain seconds-precision form is all a day boundary needs.
  const clockInTerms = [
    shiftStartIso ? `clock_in.gte.${shiftStartIso.replace(/\.\d{3}Z$/, 'Z')}` : null,
    shiftEndIso ? `clock_in.lte.${shiftEndIso.replace(/\.\d{3}Z$/, 'Z')}` : null,
  ].filter(Boolean)
  const businessDateTerms = [
    start ? `business_date.gte.${start}` : null,
    end ? `business_date.lte.${end}` : null,
  ].filter(Boolean)

  const run = async (cols) => {
    let query = supabase
      .from('staff_shifts')
      .select(`${cols}, created_at, ${JOINS}`)
      .order('clock_in', { ascending: false })
      .limit(limit)
    if (branchId) query = query.eq('branch_id', branchId)
    if (clockInTerms.length) {
      if (cols === SHIFT_COLS || cols === SHIFT_COLS_CORE) {
        query = query.or(
          `and(${businessDateTerms.join(',')}),and(business_date.is.null,${clockInTerms.join(',')})`,
        )
      } else {
        // Legacy schema has no business_date to match on.
        if (shiftStartIso) query = query.gte('clock_in', shiftStartIso)
        if (shiftEndIso) query = query.lte('clock_in', shiftEndIso)
      }
    }
    return query
  }

  // Newest schema first, then progressively older ones. A branch mid-migration still gets
  // a usable shift log instead of an empty page. The optional columns are checked before the
  // cash schema because isMissingShiftCashSchema matches "does not exist" generically: without
  // this ordering a missing optional column would be read as a missing cash schema and every
  // float and closing count would silently drop out of the result.
  let { data, error } = await run(SHIFT_COLS)
  if (error && isMissingOptionalShiftColumn(error)) {
    ;({ data, error } = await run(SHIFT_COLS_CORE))
  }
  if (error && isMissingShiftCashSchema(error)) {
    ;({ data, error } = await run(SHIFT_COLS_LEGACY))
  }
  if (error && isMissingOptionalShiftColumn(error)) {
    ;({ data, error } = await run(SHIFT_COLS_MINIMAL))
  }
  if (error) {
    if (isMissingColumnError(error, 'staff_shifts') || /staff_shifts|schema cache/i.test(String(error.message || ''))) {
      return []
    }
    throw error
  }
  // `staff:staff_id(...)` above is a PostgREST embed, filtered by `staff`'s own RLS (self
  // row or manager only) — a supervisor reading their branch's shift log got every OTHER
  // cashier's name silently blanked by that join. Re-resolve through
  // resolve_staff_identities(), which grants a supervisor their own branch, and prefer it
  // over whatever the embed did manage to return.
  const who = await fetchStaffIdentities((data || []).map((row) => row.staff_id)).catch(() => ({}))
  return (data || []).map((row) => {
    const identity = who[row.staff_id]
    const mapped = mapShiftRow(identity ? { ...row, staff: { full_name: identity.name, role: identity.role } } : row)
    return {
      ...mapped,
      branchName: row.branches?.name || '—',
      staffName: identity?.name || row.staff?.full_name || 'Staff',
    }
  })
}
