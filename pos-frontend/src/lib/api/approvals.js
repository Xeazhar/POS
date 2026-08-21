import { supabase } from '../supabase'
import { today } from '../../utils/format'
import { hasSupabase } from './shared.js'
import { resolveTillActionRequest, fetchPendingTillActionRequests } from './till.js'
import { fetchPendingCashMovements, denyCashMovement } from './cash.js'
import { clearResolvedDayEndRequest, rejectDayEndRequest } from './dayend.js'
import { dismissImportRevertRequest } from './inventoryImport.js'

/**
 * Reconciles pending till-action and day-end approval requests that were already completed.
 * @param {string} [branchId] - Branch to reconcile when the caller is not a manager.
 * @param {string} staffId - Staff member performing the reconciliation.
 * @param {boolean} [manager=false] - Whether to reconcile requests across all branches.
 */
async function reconcileResolvedPendingApprovals({ branchId, staffId, manager } = {}) {
  if (!hasSupabase || !staffId) return

  try {
    let tillQ = supabase
      .from('till_action_requests')
      .select('id, branch_id, requested_at, requested_by, meta, action, status')
      .eq('status', 'pending')
      .eq('action', 'cart_line_remove')
    if (!manager && branchId) tillQ = tillQ.eq('branch_id', branchId)
    const { data: pendingTill } = await tillQ
    if (pendingTill?.length) {
      const branchIds = [...new Set(pendingTill.map((r) => r.branch_id).filter(Boolean))]
      const oldest = pendingTill.reduce((min, row) => {
        const t = row.requested_at ? new Date(row.requested_at).getTime() : min
        return t < min ? t : min
      }, Date.now())
      const { data: auditRows } = await supabase
        .from('audit_events')
        .select('event_type, meta, created_at, branch_id, staff_id')
        .in('branch_id', branchIds)
        .gte('created_at', new Date(oldest - 60_000).toISOString())
        .in('event_type', [
          'cart_line_remove',
          'cart_line_remove_self',
          'approval:cart_line_remove',
          'approval:cart_line_remove_self',
          'till_action_approved',
          'till_action_denied',
          'till_action_self_allowed',
          'till_action_cancelled',
        ])
      for (const row of pendingTill) {
        const productId = row.meta?.product_id || row.meta?.productId || null
        const requestedAt = row.requested_at ? new Date(row.requested_at).getTime() : 0
        let approverId = null
        const resolvedOnSite = (auditRows || []).some((ev) => {
          if (new Date(ev.created_at).getTime() < requestedAt - 1000) return false
          if (ev.branch_id !== row.branch_id) return false
          if (ev.meta?.till_action_id === row.id) {
            approverId = ev.meta?.approved_by || ev.staff_id || null
            return true
          }
          const evType = String(ev.event_type || '')
          const isCartRemove =
            evType === 'cart_line_remove'
            || evType === 'cart_line_remove_self'
            || evType === 'approval:cart_line_remove'
            || evType === 'approval:cart_line_remove_self'
          if (!isCartRemove) return false
          const evProduct = ev.meta?.product_id || ev.meta?.productId || null
          if (productId && evProduct && evProduct !== productId) return false
          approverId = ev.meta?.approved_by || ev.staff_id || null
          return true
        })
        if (!resolvedOnSite) continue
        try {
          await resolveTillActionRequest({
            id: row.id,
            resolvedBy: approverId || staffId,
            status: 'approved',
          })
        } catch {
          /* already gone or permission — next fetch will retry */
        }
      }
    }
  } catch {
    /* till_action_requests may be missing */
  }

  try {
    let dayQ = supabase
      .from('day_ends')
      .select(
        'id, branch_id, business_date, status, requested_at, submitted_at, closed_at, approved_at, request_manager',
      )
      .eq('status', 'requested')
    if (!manager && branchId) dayQ = dayQ.eq('branch_id', branchId)
    const { data: pendingDays } = await dayQ
    if (!pendingDays?.length) return

    const branchIds = [...new Set(pendingDays.map((r) => r.branch_id).filter(Boolean))]
    const { data: closedRows } = await supabase
      .from('day_ends')
      .select('branch_id, business_date, status')
      .in('branch_id', branchIds)
      .in('status', ['closed', 'submitted'])

    const closedKeys = new Set(
      (closedRows || []).map((r) => `${r.branch_id}:${r.business_date}`),
    )

    const oldestDay = pendingDays.reduce((min, row) => {
      const t = row.requested_at ? new Date(row.requested_at).getTime() : min
      return t < min ? t : min
    }, Date.now())
    const { data: dayAudits } = await supabase
      .from('audit_events')
      .select('event_type, meta, created_at, branch_id')
      .in('branch_id', branchIds)
      .gte('created_at', new Date(oldestDay - 60_000).toISOString())
      .in('event_type', ['day_end_approved', 'day_end_submitted'])

    for (const row of pendingDays) {
      const requestedAt = row.requested_at ? new Date(row.requested_at).getTime() : 0
      // status='requested' with a non-null closed_at used to be a false positive: the column
      // defaulted to now() on insert (see migrate_day_end_request_notify_fix.sql). Only treat
      // a request as already counted when submit/approve stamps exist or another closed row
      // covers the same business date, or a matching day_end audit landed after the request.
      const countedAlready =
        row.submitted_at ||
        row.approved_at ||
        (row.status !== 'requested' && row.closed_at) ||
        closedKeys.has(`${row.branch_id}:${row.business_date}`) ||
        (dayAudits || []).some((ev) => {
          if (ev.branch_id !== row.branch_id) return false
          if (new Date(ev.created_at).getTime() < requestedAt - 1000) return false
          const auditDate = ev.meta?.business_date || ev.meta?.businessDate || null
          return auditDate === row.business_date || ev.meta?.day_end_id === row.id
        })
      if (!countedAlready) continue
      try {
        await clearResolvedDayEndRequest({ id: row.id, staffId })
      } catch {
        try {
          await rejectDayEndRequest({
            id: row.id,
            staffId,
            reason: 'Resolved on site',
          })
        } catch {
          /* row may have moved — next refresh drops it */
        }
      }
    }
  } catch {
    /* day_ends request columns may be missing */
  }
}

export async function fetchPendingApprovals({ role, branchId, dayOpenHour = 7, reconcileStaffId = null } = {}) {
  if (!hasSupabase) return []
  const manager = role === 'manager' || role === 'admin' || role === 'master'
  const supervisor = role === 'supervisor'
  if (!manager && !supervisor) return []

  if (reconcileStaffId) {
    await reconcileResolvedPendingApprovals({ branchId, staffId: reconcileStaffId, manager })
  }

  const bizToday = today(dayOpenHour)

  // These 8 queries are independent of each other (each reads its own table and pushes
  // into its own local array) — the only shared state was the `items.push` target, so
  // running them one after another was 8 avoidable round trips on every notification-bell
  // load. `items.sort` below doesn't care what order the arrays arrive in.

  const fetchDayEndsSubmitted = async () => {
    // Day-end awaiting approve/close
    let dayQ = supabase
      .from('day_ends')
      .select('id, business_date, status, submitted_at, branch_id, branches(name)')
      .eq('status', 'submitted')
      .order('submitted_at', { ascending: false })
      .limit(30)
    if (!manager && branchId) dayQ = dayQ.eq('branch_id', branchId)
    const { data: dayRows, error: dayErr } = await dayQ
    if (dayErr) return []
    return (dayRows || []).map((row) => {
      const branchName = row.branches?.name || 'Branch'
      return {
        id: `day-${row.id}`,
        kind: 'day_end_submitted',
        title: 'Day end awaiting approval',
        detail: `${branchName} · ${row.business_date || 'today'}`,
        href: manager ? `/manager/branches/${row.branch_id}` : '/day-end',
        createdAt: row.submitted_at || null,
        priority: 1,
      }
    })
  }

  const fetchDayEndsRequested = async () => {
    // Day-end requested by a cashier — no cash figures yet, just a flag that someone needs
    // to count the drawer. A supervisor only sees a request that was NOT specifically
    // flagged for a manager; a manager sees every request (the universal fallback). Routes
    // to /day-end (the counting form) for supervisor/cashier, since that's their own
    // branch's session. Manager gets routed to the branch dashboard instead (below).
    //
    // Do NOT require closed_at IS NULL here: legacy schema defaulted closed_at to now() on
    // insert, which hid every live request from the bell (migrate_day_end_request_notify_fix.sql).
    let requestQ = supabase
      .from('day_ends')
      .select(
        'id, business_date, status, requested_at, request_manager, branch_id, submitted_at, closed_at, approved_at, branches(name)',
      )
      .eq('status', 'requested')
      .is('submitted_at', null)
      .is('approved_at', null)
      .order('requested_at', { ascending: false })
      .limit(30)
    if (!manager) {
      requestQ = requestQ.eq('request_manager', false)
      if (branchId) requestQ = requestQ.eq('branch_id', branchId)
    }
    const { data: requestRows, error: requestErr } = await requestQ
    if (requestErr) {
      if (typeof console !== 'undefined' && import.meta.env?.DEV) {
        console.warn('[approvals] day_end requested query failed', requestErr.message || requestErr)
      }
      return []
    }
    const localItems = []
    for (const row of requestRows || []) {
      // Orphaned cashier flag — day already rolled or drawer counted elsewhere.
      const bizDate = String(row.business_date || '').slice(0, 10)
      if (bizDate && bizDate < bizToday) continue
      const branchName = row.branches?.name || 'Branch'
      localItems.push({
        id: `day-req-${row.id}`,
        kind: 'day_end_requested',
        title: row.request_manager ? 'Day end requested (manager)' : 'Day end requested',
        detail: `${branchName} · ${row.business_date || 'today'}`,
        // Manager may not be logged into the requesting branch's own session — /day-end
        // always shows whatever branch THIS session is loaded as, so route manager to the
        // branch dashboard instead (same split fetchDayEndsSubmitted uses above).
        href: manager ? `/manager/branches/${row.branch_id}` : '/day-end',
        createdAt: row.requested_at || null,
        priority: 1,
        dayEndId: row.id,
        dismissable: true,
      })
    }
    return localItems
  }

  const fetchDayEndsReopen = async () => {
    // A closed day, reopen requested — manager-only, since reopen_day_end() itself is
    // manager-only (a supervisor being stuck by their own closing is not something they can
    // self-service; they need the same escalation a cashier does).
    if (!manager) return []
    const reopenQ = supabase
      .from('day_ends')
      .select('id, business_date, status, reopen_requested_at, reopen_request_reason, branch_id, branches(name)')
      .eq('status', 'closed')
      .not('reopen_requested_at', 'is', null)
      .order('reopen_requested_at', { ascending: false })
      .limit(30)
    const { data: reopenRows, error: reopenErr } = await reopenQ
    if (reopenErr) return []
    return (reopenRows || []).map((row) => {
      const branchName = row.branches?.name || 'Branch'
      return {
        id: `day-reopen-${row.id}`,
        kind: 'day_end_reopen_requested',
        title: 'Day reopen requested',
        detail: `${branchName} · ${row.business_date || 'today'}${row.reopen_request_reason ? ` · ${row.reopen_request_reason}` : ''}`,
        href: `/manager/branches/${row.branch_id}`,
        createdAt: row.reopen_requested_at || null,
        priority: 1,
      }
    })
  }

  const fetchCashMoveItems = async () => {
    // Cash movements awaiting remote manager approval (POS Open Drawer notify path).
    // Managers see all; supervisors see branch (can still deny/PIN-approve on till).
    try {
      const moveRows = await fetchPendingCashMovements({
        branchId: manager ? null : branchId,
        manager,
      })
      return moveRows.map((row) => {
        const typeLabel =
          row.type === 'pickup'
            ? 'Cash pickup'
            : row.type === 'cash_in'
              ? 'Additional float'
              : row.type === 'opening_float'
                ? 'Opening float'
                : 'Petty cash'
        return {
          id: `cash-move-${row.id}`,
          kind: 'cash_movement_pending',
          title: `${typeLabel} awaiting approval`,
          detail: `₱${Number(row.amount || 0).toFixed(2)} · ${row.drawerLabel || row.drawerId} · ${row.requestedByName || 'Cashier'} · ${row.reason || ''}`,
          href: manager ? `/manager/branches/${row.branchId}` : '/day-end',
          createdAt: row.requestedAt || null,
          priority: 1,
          movementId: row.id,
          movement: row,
          actionable: manager || supervisor,
          dismissable: true,
        }
      })
    } catch {
      /* table may be missing until migrate_cash_movements.sql */
      return []
    }
  }

  const fetchTillActionItems = async () => {
    // Cart remove / till gates awaiting manager
    try {
      const tillRows = await fetchPendingTillActionRequests({
        branchId: manager ? null : branchId,
        manager,
      })
      return tillRows.map((row) => ({
        id: `till-act-${row.id}`,
        kind: 'till_action_pending',
        title: 'Cart remove awaiting approval',
        detail: `${row.detail || 'Remove item'} · ${row.requestedByName || 'Cashier'}`,
        href: manager ? `/manager/branches/${row.branchId}` : '/pos',
        createdAt: row.requestedAt || null,
        priority: 1,
        tillActionId: row.id,
        actionable: manager || role === 'supervisor',
        dismissable: true,
      }))
    } catch {
      /* migrate_till_action_requests.sql */
      return []
    }
  }

  const fetchPromoItems = async () => {
    // Promo dual-control — managers only
    if (!manager) return []
    const { data: promoRows, error: promoErr } = await supabase
      .from('promo_events')
      .select('id, name, status, created_at, updated_at, branch_id, branches(name)')
      .in('status', ['pending', 'stop_pending'])
      .order('created_at', { ascending: false })
      .limit(40)
    if (promoErr) return []
    return (promoRows || []).map((row) => {
      const branchName = row.branches?.name || 'Branch'
      const stop = row.status === 'stop_pending'
      return {
        id: `promo-${row.id}-${row.status}`,
        kind: stop ? 'promo_stop_pending' : 'promo_pending',
        title: stop ? 'Promo stop requested' : 'Promo awaiting approval',
        detail: `${row.name || 'Promo'} · ${branchName}`,
        href: '/manager/promos',
        createdAt: row.updated_at || row.created_at || null,
        priority: stop ? 3 : 4,
      }
    })
  }

  const fetchRefundItems = async () => {
    // Refund requests with no supervisor on site — managers only (is_manager()
    // is what the approve/reject RPCs actually check; a present supervisor
    // never needs this path, they approve in person instead).
    if (!manager) return []
    const { data: refundRows, error: refundErr } = await supabase
      .from('refund_requests')
      .select('id, mode, reason, requested_at, branch_id, branches(name), transactions(invoice_number)')
      .eq('status', 'pending')
      .order('requested_at', { ascending: false })
      .limit(40)
    if (refundErr) return []
    return (refundRows || []).map((row) => {
      const branchName = row.branches?.name || 'Branch'
      return {
        id: `refund-${row.id}`,
        kind: 'refund_pending',
        title: 'Refund awaiting approval',
        detail: `${branchName} · ${row.transactions?.invoice_number || 'sale'} · ${row.mode === 'full' ? 'Full refund' : 'Item refund'} · ${row.reason || ''}`,
        href: `/manager/branches/${row.branch_id}`,
        createdAt: row.requested_at || null,
        priority: 1,
      }
    })
  }

  const fetchRevertItems = async () => {
    // A supervisor flagged a committed import for a manager to look at (revert_import_batch
    // itself stays manager-only) — see requestImportRevert / migrate_import_revert_request.sql.
    if (!manager) return []
    const { data: revertRows, error: revertErr } = await supabase
      .from('import_batches')
      .select('id, filename, branch_id, revert_requested_at, branches(name), requester:staff!revert_requested_by(full_name)')
      .eq('status', 'revert_requested')
      .order('revert_requested_at', { ascending: false })
      .limit(40)
    if (revertErr) return []
    return (revertRows || []).map((row) => {
      const branchName = row.branches?.name || 'Branch'
      return {
        id: `import-revert-${row.id}`,
        kind: 'import_revert_pending',
        batchId: row.id,
        title: 'Import revert requested',
        detail: `${branchName} · ${row.filename || 'import'} · requested by ${row.requester?.full_name || 'supervisor'}`,
        href: `/inventory?branch=${row.branch_id}`,
        createdAt: row.revert_requested_at || null,
        priority: 2,
      }
    })
  }

  const results = await Promise.all([
    fetchDayEndsSubmitted(),
    fetchDayEndsRequested(),
    fetchDayEndsReopen(),
    fetchCashMoveItems(),
    fetchTillActionItems(),
    fetchPromoItems(),
    fetchRefundItems(),
    fetchRevertItems(),
  ])
  const items = results.flat()

  items.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  })
  return items
}

/** Clear a stale inbox row once the till already handled it on-site. */
export async function dismissNotificationItem({ item, staffId }) {
  if (!hasSupabase || !item || !staffId) return
  switch (item.kind) {
    case 'till_action_pending':
      if (item.tillActionId) {
        try {
          await resolveTillActionRequest({
            id: item.tillActionId,
            resolvedBy: staffId,
            status: 'denied',
          })
        } catch (err) {
          const msg = String(err?.message || '')
          if (!/TILL_ACT04|already resolved/i.test(msg)) throw err
        }
      }
      break
    case 'day_end_requested':
      if (item.dayEndId) {
        await rejectDayEndRequest({
          id: item.dayEndId,
          staffId,
          reason: 'Resolved on site',
        })
      }
      break
    case 'cash_movement_pending':
      if (item.movementId) {
        await denyCashMovement({ id: item.movementId, deniedBy: staffId })
      }
      break
    case 'import_revert_pending':
      if (item.batchId) {
        await dismissImportRevertRequest(item.batchId, staffId)
      }
      break
    default:
      break
  }
}
