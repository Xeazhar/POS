import { supabase } from '../supabase'
import { appError } from '../../utils/errors'
import { localDateKey } from '../../utils/format'
import { mapDayEndRow } from './shared.js'

export async function clearResolvedDayEndRequest({ id, staffId }) {
  const { data, error } = await supabase.rpc('clear_resolved_day_end_request', {
    p_day_end_id: id,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

export async function submitDayEnd({ branchId, staffId, entry }) {
  const { data, error } = await supabase.rpc('submit_day_end', {
    p_branch_id: branchId,
    p_staff_id: staffId,
    p_business_date: entry.date,
    p_recorded_cash: entry.recordedCash,
    p_cash_on_hand: entry.cashOnHand,
    p_variance: entry.variance,
    p_expected_cash: entry.expectedCash ?? 0,
    p_note: entry.note || null,
    p_day_report: entry.dayReport ?? null,
    p_day_end_id: entry.id || null,
  })
  if (error) throw error
  return data
}

export async function approveDayEnd({ id, staffId }) {
  const { data, error } = await supabase.rpc('approve_day_end', {
    p_day_end_id: id,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

/** @deprecated use submitDayEnd — kept for offline queue compatibility */
export async function closeDayEnd(payload) {
  return submitDayEnd(payload)
}

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

/**
 * A cashier (or anyone on the branch) blocked by a closed business day asks a manager to
 * reopen it — reopening itself stays manager-only (`reopenDayEnd`), this just gives the
 * person stuck at the till a way to ask instead of being stuck with no recourse but signing
 * out. Surfaces to managers via `fetchPendingApprovals`.
 */
export async function requestDayReopen({ id, staffId, reason }) {
  const { data, error } = await supabase.rpc('request_day_reopen', {
    p_day_end_id: id,
    p_staff_id: staffId,
    p_reason: reason || null,
  })
  if (error) throw error
  return data
}

/** Supervisor/manager declines a cashier's "Request day end" made by mistake. */
export async function rejectDayEndRequest({ id, staffId, reason }) {
  const { data, error } = await supabase.rpc('reject_day_end_request', {
    p_day_end_id: id,
    p_staff_id: staffId,
    p_reason: reason || null,
  })
  if (error) throw error
  return data
}

/**
 * A cashier flags the business day for closing — no cash figures yet. Whoever answers it
 * (a supervisor, or a manager if `requestManager` was set) counts the drawer on the normal
 * Close Day screen, which overwrites this with real numbers and closes as usual.
 */
export async function requestDayEnd({ branchId, staffId, businessDate, requestManager = false }) {
  const { data, error } = await supabase.rpc('request_day_end', {
    p_branch_id: branchId,
    p_staff_id: staffId,
    p_business_date: businessDate,
    p_request_manager: requestManager,
  })
  if (error) throw error
  return data
}

/** branch_id/business_date/status only, last 2 days — for the Branches grid's "Day not
 *  ended" tag. RLS (is_manager()) already scopes this to every branch the caller may see. */
export async function fetchRecentDayEndStatuses() {
  const since = localDateKey(new Date(Date.now() - 86400000))
  const { data, error } = await supabase
    .from('day_ends')
    .select('branch_id, business_date, status')
    .gte('business_date', since)
  if (error) throw error
  return data || []
}
