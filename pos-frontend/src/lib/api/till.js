import { supabase } from '../supabase'
import { hasSupabase, fetchAllRows, fetchStaffIdentities } from './shared.js'

export function mapTillActionRequest(row) {
  if (!row) return null
  return {
    id: row.id,
    clientId: row.client_id || null,
    branchId: row.branch_id,
    action: row.action,
    detail: row.detail || '',
    meta: row.meta || {},
    status: row.status,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at || null,
    resolvedBy: row.resolved_by || null,
    resolvedAt: row.resolved_at || null,
    selfRecordAck: Boolean(row.self_record_ack),
  }
}

export async function createTillActionRequest({
  branchId,
  requestedBy,
  action,
  detail,
  meta = {},
  clientId = null,
}) {
  const { data, error } = await supabase.rpc('create_till_action_request', {
    p_branch_id: branchId,
    p_requested_by: requestedBy,
    p_action: action,
    p_detail: detail,
    p_meta: meta,
    p_client_id: clientId,
  })
  if (error) throw error
  return mapTillActionRequest(data)
}

export async function resolveTillActionRequest({ id, resolvedBy, status, ack = false }) {
  const { data, error } = await supabase.rpc('resolve_till_action_request', {
    p_id: id,
    p_resolved_by: resolvedBy,
    p_status: status,
    p_ack: Boolean(ack),
  })
  if (error) throw error
  return mapTillActionRequest(data)
}

/**
 * Clear pending cart-remove alerts once the till resolves on-site (supervisor PIN,
 * manager session, self-allow after timeout). Best-effort — ignores already-resolved rows.
 */
export async function dismissPendingTillActionsOnSite({
  requestId = null,
  branchId,
  requestedBy,
  resolvedBy,
  productId = null,
  status = 'approved',
  ack = false,
} = {}) {
  if (!hasSupabase || !branchId || !resolvedBy) return

  const candidateIds = []
  if (requestId && requestId !== 'demo') candidateIds.push(requestId)

  let q = supabase
    .from('till_action_requests')
    .select('id, meta')
    .eq('branch_id', branchId)
    .eq('status', 'pending')
    .eq('action', 'cart_line_remove')
  if (requestedBy) q = q.eq('requested_by', requestedBy)
  const { data: rows, error } = await q
  if (!error) {
    for (const row of rows || []) {
      const metaProductId = row.meta?.product_id || row.meta?.productId || null
      if (productId && metaProductId && metaProductId !== productId) continue
      candidateIds.push(row.id)
    }
  }

  const seen = new Set()
  for (const id of candidateIds) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    try {
      await resolveTillActionRequest({ id, resolvedBy, status, ack })
    } catch (err) {
      const msg = String(err?.message || '')
      if (/TILL_ACT04|already resolved/i.test(msg)) continue
      if (/TILL_ACT09|TILL_ACT05|TILL_ACT08/i.test(msg) && status !== 'denied') {
        try {
          await resolveTillActionRequest({ id, resolvedBy, status: 'denied', ack: false })
        } catch {
          /* inbox refresh will retry reconcile */
        }
      }
    }
  }
}

export async function fetchTillActionRequestById(id) {
  if (!hasSupabase || !id) return null
  const { data, error } = await supabase
    .from('till_action_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    if (/till_action_requests|schema cache|does not exist/i.test(String(error.message || ''))) {
      return null
    }
    throw error
  }
  const mapped = mapTillActionRequest(data)
  if (!mapped) return null
  const who = await fetchStaffIdentities([mapped.requestedBy, mapped.resolvedBy]).catch(() => ({}))
  return {
    ...mapped,
    requestedByName: mapped.requestedBy ? who[mapped.requestedBy]?.name || null : null,
    resolvedByName: mapped.resolvedBy ? who[mapped.resolvedBy]?.name || null : null,
  }
}

const CART_REMOVE_AUDIT_TYPES = [
  'approval:cart_line_remove',
  'approval:cart_line_remove_self',
  'till_action_denied',
  'till_action_cancelled',
]

function cartRemoveOutcomeFromAudit(eventType) {
  if (eventType === 'approval:cart_line_remove_self') return 'removed_unapproved'
  if (eventType === 'approval:cart_line_remove') return 'removed'
  if (eventType === 'till_action_denied') return 'denied'
  if (eventType === 'till_action_cancelled') return 'cancelled'
  return 'other'
}

function cartRemoveMethodLabel(via) {
  const map = {
    pin: 'Supervisor PIN',
    remote: 'Manager remote',
    manager_session: 'Manager on-site',
    self_allowed: 'Self-allowed (timeout)',
  }
  return map[via] || via || '—'
}

/**
 * Cart line removals for fraud review — audit_events (completed + denied/cancelled)
 * plus open till_action_requests still pending in range.
 */
export async function fetchCartRemoveReport({
  start,
  end,
  branchId,
  requestedBy = null,
  outcome = null,
} = {}) {
  if (!hasSupabase) return []
  try {
    const auditRes = await fetchAllRows((from, to) => {
      let q = supabase
        .from('audit_events')
        .select('*, staff(full_name), branches(name)')
        .in('event_type', CART_REMOVE_AUDIT_TYPES)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to)
      if (start) q = q.gte('created_at', `${start}T00:00:00+08:00`)
      if (end) q = q.lte('created_at', `${end}T23:59:59.999+08:00`)
      if (branchId) q = q.eq('branch_id', branchId)
      return q
    })
    if (auditRes.error) throw auditRes.error

    const tillRes = await fetchAllRows((from, to) => {
      let q = supabase
        .from('till_action_requests')
        .select('*')
        .eq('action', 'cart_line_remove')
        .eq('status', 'pending')
        .order('requested_at', { ascending: false })
        .range(from, to)
      if (start) q = q.gte('requested_at', `${start}T00:00:00+08:00`)
      if (end) q = q.lte('requested_at', `${end}T23:59:59.999+08:00`)
      if (branchId) q = q.eq('branch_id', branchId)
      if (requestedBy) q = q.eq('requested_by', requestedBy)
      return q
    })
    if (tillRes.error && !/till_action_requests|schema cache|does not exist/i.test(String(tillRes.error.message || ''))) {
      throw tillRes.error
    }

    const staffIds = new Set()
    for (const row of auditRes.data || []) {
      const meta = row.meta || {}
      if (row.staff_id) staffIds.add(row.staff_id)
      if (meta.requested_by) staffIds.add(meta.requested_by)
      if (meta.approved_by) staffIds.add(meta.approved_by)
    }
    for (const row of tillRes.data || []) {
      if (row.requested_by) staffIds.add(row.requested_by)
    }
    const who = await fetchStaffIdentities([...staffIds]).catch(() => ({}))

    const rows = []
    const byTill = new Map()

    for (const row of auditRes.data || []) {
      const meta = row.meta || {}
      const rowOutcome = cartRemoveOutcomeFromAudit(row.event_type)
      if (requestedBy && meta.requested_by !== requestedBy && row.staff_id !== requestedBy) continue
      if (outcome && rowOutcome !== outcome) continue

      const tillId = meta.till_action_id || null
      const cashierId = meta.requested_by || row.staff_id
      const mapped = {
        when: row.created_at,
        branch: row.branches?.name || '',
        item: meta.product_name || meta.promo_name || row.detail || '—',
        product_id: meta.product_id || meta.promo_group || '',
        quantity: meta.quantity ?? meta.line_count ?? '',
        line_value: meta.line_total != null ? Number(meta.line_total) : null,
        cashier: who[cashierId]?.name || row.staff?.full_name || '—',
        approved_by:
          meta.approver_name && meta.approver_role
            ? `${meta.approver_name} (${meta.approver_role})`
            : meta.approver_name || (meta.approved_by ? who[meta.approved_by]?.name : '') || '—',
        outcome: rowOutcome,
        method: cartRemoveMethodLabel(meta.via),
        detail: row.detail || '',
        request_id: tillId || '',
      }

      if (tillId && rowOutcome.startsWith('removed')) {
        const prev = byTill.get(tillId)
        if (
          prev &&
          (prev.line_value == null || (mapped.line_value != null && mapped.line_value >= prev.line_value))
        ) {
          byTill.set(tillId, mapped)
        } else if (!prev) {
          byTill.set(tillId, mapped)
        }
        continue
      }

      rows.push(mapped)
    }

    for (const mapped of byTill.values()) {
      rows.push(mapped)
    }

    for (const row of tillRes.data || []) {
      if (outcome && outcome !== 'pending') continue
      const meta = row.meta || {}
      rows.push({
        when: row.requested_at,
        branch: '',
        item: meta.product_name || row.detail || '—',
        product_id: meta.product_id || '',
        quantity: meta.quantity ?? '',
        line_value: meta.line_total != null ? Number(meta.line_total) : null,
        cashier: who[row.requested_by]?.name || '—',
        approved_by: '—',
        outcome: 'pending',
        method: 'Awaiting manager',
        detail: row.detail || '',
        request_id: row.id,
      })
    }

    rows.sort((a, b) => String(b.when || '').localeCompare(String(a.when || '')))
    return rows
  } catch (err) {
    if (/audit_events|till_action_requests|schema cache|does not exist/i.test(String(err?.message || ''))) {
      return []
    }
    throw err
  }
}

export async function fetchPendingTillActionRequests({ branchId = null, manager = false } = {}) {
  if (!hasSupabase) return []
  try {
    let q = supabase
      .from('till_action_requests')
      .select('*')
      .eq('status', 'pending')
      .order('requested_at', { ascending: false })
      .limit(40)
    if (!manager && branchId) q = q.eq('branch_id', branchId)
    const { data, error } = await q
    if (error) {
      if (/till_action_requests|schema cache|does not exist/i.test(String(error.message || ''))) {
        return []
      }
      throw error
    }
    const rows = (data || []).map(mapTillActionRequest).filter(Boolean)
    const who = await fetchStaffIdentities(rows.map((r) => r.requestedBy)).catch(() => ({}))
    return rows.map((row) => ({
      ...row,
      requestedByName: row.requestedBy ? who[row.requestedBy]?.name || null : null,
    }))
  } catch (err) {
    if (/till_action_requests|schema cache|does not exist/i.test(String(err?.message || ''))) {
      return []
    }
    throw err
  }
}
